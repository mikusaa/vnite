use std::{collections::BTreeMap, mem::size_of, path::Path, ptr};

use napi_derive::napi;
use quick_xml::{events::Event, Reader};
use windows::{
  core::{w, BSTR, PCWSTR, PWSTR},
  Win32::{
    Foundation::{
      CloseHandle, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_NONE_MAPPED, E_ACCESSDENIED,
      E_INVALIDARG, GENERIC_EXECUTE, GENERIC_READ, HANDLE, HLOCAL, WAIT_OBJECT_0,
    },
    Security::{
      Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
      },
      GetAce, GetSecurityDescriptorDacl, GetTokenInformation, LookupAccountNameW, SetFileSecurityW,
      TokenSessionId, TokenUser, ACCESS_ALLOWED_ACE, ACL, LABEL_SECURITY_INFORMATION,
      PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ},
    System::{
      Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
      },
      Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, REG_SZ, RRF_RT_REG_SZ,
      },
      TaskScheduler::{
        ITaskFolder, ITaskService, TaskScheduler, TASK_CREATE_OR_UPDATE,
        TASK_DONT_ADD_PRINCIPAL_ACE, TASK_ENUM_HIDDEN, TASK_LOGON_INTERACTIVE_TOKEN,
        TASK_RUN_USE_SESSION_ID,
      },
      Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject},
      Variant::VARIANT,
    },
    UI::Shell::{
      FOLDERID_LocalAppData, SHGetKnownFolderPath, ShellExecuteExW, KF_FLAG_DEFAULT,
      SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    },
  },
};
use windows_core::{Error, Result, HRESULT};

const LAYERS: PCWSTR =
  w!("Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers");

#[napi(object)]
#[derive(Clone)]
pub struct StartupIdentity {
  pub sid: String,
  pub elevated: bool,
  pub session_id: u32,
  pub exe_path: String,
  pub installation_id: String,
  pub state_directory: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct StartupTaskProbe {
  pub launch: String,
  pub logon: String,
  pub run_as_admin_flag: bool,
}

#[napi(object)]
#[derive(Clone)]
pub struct StartupTaskSnapshot {
  pub launch_xml: Option<String>,
  pub launch_security: Option<String>,
  pub logon_xml: Option<String>,
  pub logon_security: Option<String>,
  pub user_compat: Option<String>,
  pub machine_compat: Option<String>,
}

#[napi(object)]
pub struct StartupHelperResult {
  pub exit_code: u32,
}

struct Handle(HANDLE);
impl Drop for Handle {
  fn drop(&mut self) {
    unsafe {
      let _ = CloseHandle(self.0);
    }
  }
}
struct ComApartment;
impl Drop for ComApartment {
  fn drop(&mut self) {
    unsafe {
      CoUninitialize();
    }
  }
}

fn invalid(message: impl Into<String>) -> Error {
  Error::new(E_INVALIDARG, message.into())
}
fn to_napi(error: Error) -> napi::Error {
  let message = error
    .message()
    .replace('\\', "\\\\")
    .replace('"', "\\\"")
    .replace('\r', "\\r")
    .replace('\n', "\\n");
  napi::Error::from_reason(format!(
    r#"{{"domain":"hresult","code":{},"message":"{}"}}"#,
    error.code().0 as u32,
    message
  ))
}

async fn background<T, F>(operation: F) -> napi::Result<T>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T> + Send + 'static,
{
  // COM interfaces never leave this dedicated apartment or reach the JS thread.
  tokio::task::spawn_blocking(move || {
    std::thread::spawn(move || {
      unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
      }
      let _apartment = ComApartment;
      operation()
    })
    .join()
    .map_err(|_| invalid("startup worker panicked"))?
  })
  .await
  .map_err(|e| napi::Error::from_reason(e.to_string()))?
  .map_err(to_napi)
}

fn normalize_path(value: &str) -> String {
  value
    .trim_start_matches("\\\\?\\")
    .replace('/', "\\")
    .trim_end_matches('\\')
    .to_lowercase()
}

fn installation_id(exe: &str) -> String {
  let hash = normalize_path(exe)
    .bytes()
    .fold(0xcbf29ce484222325u64, |h, b| {
      (h ^ b as u64).wrapping_mul(0x100000001b3)
    });
  format!("{hash:016x}")
}

fn identity() -> Result<StartupIdentity> {
  unsafe {
    let mut token = HANDLE::default();
    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
    let token = Handle(token);
    let mut length = 0;
    let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
    if length == 0 {
      return Err(Error::from_thread());
    }
    let mut buffer = vec![0u8; length as usize];
    GetTokenInformation(
      token.0,
      TokenUser,
      Some(buffer.as_mut_ptr().cast()),
      length,
      &mut length,
    )?;
    let user = ptr::read_unaligned(buffer.as_ptr().cast::<TOKEN_USER>());
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut text)?;
    let sid = text.to_string().map_err(|e| invalid(e.to_string()));
    LocalFree(Some(HLOCAL(text.0.cast())));
    let sid = sid?;
    let mut session_id = 0u32;
    GetTokenInformation(
      token.0,
      TokenSessionId,
      Some((&mut session_id as *mut u32).cast()),
      4,
      &mut length,
    )?;
    let directory = SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None)?;
    let local = directory.to_string().map_err(|e| invalid(e.to_string()));
    CoTaskMemFree(Some(directory.0.cast()));
    let exe_path = std::env::current_exe()
      .map_err(|e| invalid(e.to_string()))?
      .to_string_lossy()
      .into_owned();
    let installation_id = installation_id(&exe_path);
    Ok(StartupIdentity {
      sid,
      elevated: super::privilege::is_elevated_privilege()?,
      session_id,
      state_directory: Path::new(&local?)
        .join("Vnite")
        .join("startup")
        .join(&installation_id)
        .to_string_lossy()
        .into_owned(),
      exe_path,
      installation_id,
    })
  }
}

fn task_name(id: &StartupIdentity, kind: &str) -> String {
  format!("Vnite-{kind}-{}-{}", id.sid, id.installation_id)
}

fn scheduler() -> Result<ITaskFolder> {
  unsafe {
    let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
    service.Connect(
      &VARIANT::default(),
      &VARIANT::default(),
      &VARIANT::default(),
      &VARIANT::default(),
    )?;
    service.GetFolder(&BSTR::from("\\"))
  }
}

fn missing(error: &Error) -> bool {
  error.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0)
}

fn xml_escape(value: &str) -> String {
  quick_xml::escape::escape(value).into_owned()
}

fn task_xml(id: &StartupIdentity, logon: bool, enabled: bool) -> String {
  let triggers = if logon {
    format!(
      "<LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger>",
      xml_escape(&id.sid)
    )
  } else {
    String::new()
  };
  let args = if logon {
    "--vnite-admin-logon --hidden"
  } else {
    "--vnite-admin-request=$(Arg0)"
  };
  let working_directory = Path::new(&id.exe_path).parent().unwrap().to_string_lossy();
  format!(
    r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Vnite {} {}</Description></RegistrationInfo>
<Triggers>{}</Triggers>
<Principals><Principal id="Vnite"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>{}</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>{}</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="Vnite"><Exec><Command>{}</Command><Arguments>{}</Arguments><WorkingDirectory>{}</WorkingDirectory></Exec></Actions></Task>"#,
    id.installation_id,
    if logon { "logon" } else { "launch" },
    triggers,
    xml_escape(&id.sid),
    if logon { "IgnoreNew" } else { "Parallel" },
    enabled,
    xml_escape(&id.exe_path),
    args,
    xml_escape(&working_directory)
  )
}

fn xml_values(xml: &str) -> Result<BTreeMap<String, String>> {
  let mut reader = Reader::from_str(xml);
  let mut stack = Vec::<String>::new();
  let mut values = BTreeMap::new();
  loop {
    match reader.read_event().map_err(|e| invalid(e.to_string()))? {
      Event::Start(event) => {
        stack.push(String::from_utf8_lossy(event.local_name().as_ref()).into_owned())
      }
      Event::End(_) => {
        stack.pop();
      }
      Event::Text(text) => {
        let decoded = text.decode().map_err(|e| invalid(e.to_string()))?;
        if decoded.trim().is_empty() {
          continue;
        }
        let value = quick_xml::escape::unescape(&decoded)
          .map_err(|e| invalid(e.to_string()))?
          .into_owned();
        values
          .entry(stack.join("/"))
          .or_insert_with(String::new)
          .push_str(&value);
      }
      Event::GeneralRef(reference) => {
        let encoded = format!(
          "&{};",
          reference.decode().map_err(|e| invalid(e.to_string()))?
        );
        let value = quick_xml::escape::unescape(&encoded).map_err(|e| invalid(e.to_string()))?;
        values
          .entry(stack.join("/"))
          .or_insert_with(String::new)
          .push_str(&value);
      }
      Event::Eof => break,
      _ => {}
    }
  }
  Ok(values)
}

fn same_account(value: &str, expected_sid: &str) -> Result<bool> {
  if value.eq_ignore_ascii_case(expected_sid) {
    return Ok(true);
  }
  if value.is_empty() || value.starts_with("S-1-") {
    return Ok(false);
  }
  // Task Scheduler can serialize an account name even when registration used
  // its SID. Resolve it instead of comparing the two display representations.
  unsafe {
    let name: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut sid_size = 0;
    let mut domain_size = 0;
    let mut usage = SID_NAME_USE::default();
    let result = LookupAccountNameW(
      None,
      PCWSTR(name.as_ptr()),
      None,
      &mut sid_size,
      None,
      &mut domain_size,
      &mut usage,
    );
    if sid_size == 0 {
      return match result {
        Err(error) if error.code() == HRESULT::from_win32(ERROR_NONE_MAPPED.0) => Ok(false),
        Err(error) => Err(error),
        Ok(()) => Ok(false),
      };
    }
    let mut sid = vec![0u8; sid_size as usize];
    let mut domain = vec![0u16; domain_size as usize];
    LookupAccountNameW(
      None,
      PCWSTR(name.as_ptr()),
      Some(PSID(sid.as_mut_ptr().cast())),
      &mut sid_size,
      Some(PWSTR(domain.as_mut_ptr())),
      &mut domain_size,
      &mut usage,
    )?;
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(PSID(sid.as_mut_ptr().cast()), &mut text)?;
    let resolved = text.to_string().map_err(|e| invalid(e.to_string()));
    LocalFree(Some(HLOCAL(text.0.cast())));
    Ok(resolved?.eq_ignore_ascii_case(expected_sid))
  }
}

fn task_xml_default(key: &str) -> Option<&'static str> {
  // Task Scheduler omits these elements when their schema default is true.
  // Missing security-, action- and battery-related fields must still fail.
  match key {
    "Task/Settings/Enabled"
    | "Task/Settings/AllowStartOnDemand"
    | "Task/Triggers/LogonTrigger/Enabled" => Some("true"),
    _ => None,
  }
}

fn validate_task(xml: &str, id: &StartupIdentity, logon: bool, enabled: bool) -> Result<String> {
  let actual = xml_values(xml)?;
  let expected = xml_values(&task_xml(id, logon, enabled))?;
  let get = |key: &str| {
    actual
      .get(key)
      .map(String::as_str)
      .or_else(|| task_xml_default(key))
      .unwrap_or("")
  };
  if normalize_path(get("Task/Actions/Exec/Command")) != normalize_path(&id.exe_path) {
    return Ok("stale-path".into());
  }
  if !same_account(get("Task/Principals/Principal/UserId"), &id.sid)? {
    return Ok("wrong-principal".into());
  }
  if get("Task/Principals/Principal/LogonType") != "InteractiveToken" {
    return Ok("wrong-logon-type".into());
  }
  if get("Task/Principals/Principal/RunLevel") != "HighestAvailable" {
    return Ok("wrong-runlevel".into());
  }
  for (key, value) in expected {
    if key.starts_with("Task/RegistrationInfo/") {
      continue;
    }
    let matches = if key.ends_with("/UserId") {
      same_account(get(&key), &id.sid)?
    } else if key.ends_with("/Command") || key.ends_with("/WorkingDirectory") {
      normalize_path(get(&key)) == normalize_path(&value)
    } else {
      get(&key) == value
    };
    if !matches {
      return Ok("invalid-settings".into());
    }
  }
  // Additional actions or triggers would make this more than the fixed Vnite task.
  let mut reader = Reader::from_str(xml);
  let mut execs = 0;
  let mut trigger_count = 0;
  loop {
    match reader.read_event().map_err(|e| invalid(e.to_string()))? {
      Event::Start(e) | Event::Empty(e) => {
        let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
        if name == "Exec" {
          execs += 1;
        }
        if name.ends_with("Trigger") {
          trigger_count += 1;
        }
      }
      Event::Eof => break,
      _ => {}
    }
  }
  if execs != 1 || trigger_count != if logon { 1 } else { 0 } {
    return Ok("invalid-settings".into());
  }
  Ok("ok".into())
}

fn probe_one(
  folder: &ITaskFolder,
  id: &StartupIdentity,
  logon: bool,
  enabled: bool,
) -> Result<String> {
  unsafe {
    match folder.GetTask(&BSTR::from(task_name(
      id,
      if logon { "Logon" } else { "Launch" },
    ))) {
      Ok(task) => {
        if task.Enabled()?.as_bool() != enabled {
          return Ok("disabled".into());
        }
        if !task_permissions(&task.GetSecurityDescriptor(4)?.to_string(), &id.sid)? {
          return Ok("invalid-settings".into());
        }
        validate_task(&task.Xml()?.to_string(), id, logon, enabled)
      }
      Err(e) if missing(&e) => Ok("absent".into()),
      Err(e) => Err(e),
    }
  }
}

fn task_permissions(sddl: &str, user_sid: &str) -> Result<bool> {
  unsafe {
    let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
      PCWSTR(text.as_ptr()),
      SDDL_REVISION_1,
      &mut descriptor,
      None,
    )?;
    let result = (|| {
      let mut present = windows_core::BOOL(0);
      let mut defaulted = windows_core::BOOL(0);
      let mut acl: *mut ACL = ptr::null_mut();
      GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)?;
      if !present.as_bool() || acl.is_null() {
        return Ok(false);
      }
      let allowed = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;
      let mut user_access = 0;
      for index in 0..(*acl).AceCount as u32 {
        let mut raw = ptr::null_mut();
        GetAce(acl, index, &mut raw)?;
        let ace = &*(raw as *const ACCESS_ALLOWED_ACE);
        // Only explicit allow ACEs for SYSTEM, Administrators and this user.
        if ace.Header.AceType != 0 {
          return Ok(false);
        }
        let mut sid_text = PWSTR::null();
        ConvertSidToStringSidW(
          PSID((&ace.SidStart as *const u32).cast_mut().cast()),
          &mut sid_text,
        )?;
        let sid = sid_text.to_string().map_err(|e| invalid(e.to_string()));
        LocalFree(Some(HLOCAL(sid_text.0.cast())));
        let sid = sid?;
        if sid == "S-1-5-18" || sid == "S-1-5-32-544" {
          continue;
        }
        if sid != user_sid {
          return Ok(false);
        }
        let mut mask = ace.Mask;
        if mask & GENERIC_READ.0 != 0 {
          mask = (mask & !GENERIC_READ.0) | FILE_GENERIC_READ.0;
        }
        if mask & GENERIC_EXECUTE.0 != 0 {
          mask = (mask & !GENERIC_EXECUTE.0) | FILE_GENERIC_EXECUTE.0;
        }
        if mask & !allowed != 0 {
          return Ok(false);
        }
        user_access |= mask;
      }
      Ok(user_access & allowed == allowed)
    })();
    LocalFree(Some(HLOCAL(descriptor.0)));
    result
  }
}

fn read_compat(hive: HKEY, exe: &str) -> Result<Option<String>> {
  unsafe {
    let mut bytes = 0;
    let value: Vec<u16> = exe.encode_utf16().chain(Some(0)).collect();
    let result = RegGetValueW(
      hive,
      LAYERS,
      PCWSTR(value.as_ptr()),
      RRF_RT_REG_SZ,
      None,
      None,
      Some(&mut bytes),
    );
    if result == ERROR_FILE_NOT_FOUND {
      return Ok(None);
    }
    result.ok()?;
    let mut data = vec![0u16; bytes as usize / 2 + 1];
    RegGetValueW(
      hive,
      LAYERS,
      PCWSTR(value.as_ptr()),
      RRF_RT_REG_SZ,
      None,
      Some(data.as_mut_ptr().cast()),
      Some(&mut bytes),
    )
    .ok()?;
    Ok(Some(
      String::from_utf16_lossy(&data[..bytes as usize / 2])
        .trim_end_matches('\0')
        .to_string(),
    ))
  }
}

fn write_compat(hive: HKEY, exe: &str, contents: Option<&str>) -> Result<()> {
  unsafe {
    let key: Vec<u16> = exe.encode_utf16().chain(Some(0)).collect();
    if let Some(contents) = contents {
      let data: Vec<u16> = contents.encode_utf16().chain(Some(0)).collect();
      RegSetKeyValueW(
        hive,
        LAYERS,
        PCWSTR(key.as_ptr()),
        REG_SZ.0,
        Some(data.as_ptr().cast()),
        (data.len() * 2) as u32,
      )
      .ok()
    } else {
      let result = RegDeleteKeyValueW(hive, LAYERS, PCWSTR(key.as_ptr()));
      if result == ERROR_FILE_NOT_FOUND {
        Ok(())
      } else {
        result.ok()
      }
    }
  }
}

fn without_admin(value: &str) -> String {
  value
    .split_whitespace()
    .filter(|flag| !flag.eq_ignore_ascii_case("RUNASADMIN"))
    .collect::<Vec<_>>()
    .join(" ")
}

fn has_admin_flag(value: &str) -> bool {
  value
    .split_whitespace()
    .any(|flag| flag.eq_ignore_ascii_case("RUNASADMIN"))
}

fn snapshot(folder: &ITaskFolder, id: &StartupIdentity) -> Result<StartupTaskSnapshot> {
  let one = |name: &str| -> Result<(Option<String>, Option<String>)> {
    unsafe {
      match folder.GetTask(&BSTR::from(name)) {
        Ok(task) => Ok((
          Some(task.Xml()?.to_string()),
          Some(task.GetSecurityDescriptor(7)?.to_string()),
        )),
        Err(e) if missing(&e) => Ok((None, None)),
        Err(e) => Err(e),
      }
    }
  };
  let (launch_xml, launch_security) = one(&task_name(id, "Launch"))?;
  let (logon_xml, logon_security) = one(&task_name(id, "Logon"))?;
  Ok(StartupTaskSnapshot {
    launch_xml,
    launch_security,
    logon_xml,
    logon_security,
    user_compat: read_compat(HKEY_CURRENT_USER, &id.exe_path)?,
    machine_compat: read_compat(HKEY_LOCAL_MACHINE, &id.exe_path)?,
  })
}

fn register(
  folder: &ITaskFolder,
  id: &StartupIdentity,
  kind: &str,
  xml: &str,
  security: Option<&str>,
) -> Result<()> {
  // High-integrity ownership and a fixed action prevent medium-integrity callers
  // from editing a task into an arbitrary elevated command.
  let security = security
    .map(str::to_owned)
    .unwrap_or_else(|| format!("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;{})", id.sid));
  unsafe {
    folder.RegisterTask(
      &BSTR::from(task_name(id, kind)),
      &BSTR::from(xml),
      TASK_CREATE_OR_UPDATE.0 | TASK_DONT_ADD_PRINCIPAL_ACE.0,
      &VARIANT::from(id.sid.as_str()),
      &VARIANT::default(),
      TASK_LOGON_INTERACTIVE_TOKEN,
      &VARIANT::from(security.as_str()),
    )?;
  }
  Ok(())
}

fn delete(folder: &ITaskFolder, name: &str) -> Result<()> {
  unsafe {
    match folder.DeleteTask(&BSTR::from(name), 0) {
      Err(e) if missing(&e) => Ok(()),
      result => result,
    }
  }
}

fn restore(folder: &ITaskFolder, id: &StartupIdentity, before: &StartupTaskSnapshot) -> Result<()> {
  for (kind, xml, security) in [
    ("Launch", &before.launch_xml, &before.launch_security),
    ("Logon", &before.logon_xml, &before.logon_security),
  ] {
    if let Some(xml) = xml {
      register(folder, id, kind, xml, security.as_deref())?;
    } else {
      delete(folder, &task_name(id, kind))?;
    }
  }
  write_compat(
    HKEY_CURRENT_USER,
    &id.exe_path,
    before.user_compat.as_deref(),
  )?;
  write_compat(
    HKEY_LOCAL_MACHINE,
    &id.exe_path,
    before.machine_compat.as_deref(),
  )?;
  Ok(())
}

#[napi(js_name = "getStartupIdentity")]
pub async fn get_startup_identity() -> napi::Result<StartupIdentity> {
  background(identity).await
}

#[napi(js_name = "prepareStartupStorage")]
pub async fn prepare_startup_storage() -> napi::Result<()> {
  background(|| {
    let id = identity()?;
    std::fs::create_dir_all(Path::new(&id.state_directory).join("requests"))
      .map_err(|e| invalid(e.to_string()))?;
    // Replies and atomic state replacements must remain writable after switching
    // between the same user's medium- and high-integrity processes.
    unsafe {
      let mut descriptor = PSECURITY_DESCRIPTOR::default();
      ConvertStringSecurityDescriptorToSecurityDescriptorW(
        w!("S:(ML;OICI;NW;;;ME)"),
        SDDL_REVISION_1,
        &mut descriptor,
        None,
      )?;
      let result = (|| -> Result<()> {
        for directory in [
          Path::new(&id.state_directory).to_path_buf(),
          Path::new(&id.state_directory).join("requests"),
        ] {
          let wide: Vec<u16> = directory
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
          SetFileSecurityW(
            PCWSTR(wide.as_ptr()),
            LABEL_SECURITY_INFORMATION,
            descriptor,
          )
          .ok()?;
        }
        Ok(())
      })();
      LocalFree(Some(HLOCAL(descriptor.0)));
      result?;
    }
    Ok(())
  })
  .await
}

#[napi(js_name = "probeStartupTasks")]
pub async fn probe_startup_tasks(open_at_login: bool) -> napi::Result<StartupTaskProbe> {
  background(move || {
    let id = identity()?;
    let folder = scheduler()?;
    let user = read_compat(HKEY_CURRENT_USER, &id.exe_path)?.unwrap_or_default();
    let machine = read_compat(HKEY_LOCAL_MACHINE, &id.exe_path)?.unwrap_or_default();
    Ok(StartupTaskProbe {
      launch: probe_one(&folder, &id, false, true)?,
      logon: probe_one(&folder, &id, true, open_at_login)?,
      run_as_admin_flag: has_admin_flag(&user) || has_admin_flag(&machine),
    })
  })
  .await
}

#[napi(js_name = "configureStartupTasks")]
pub async fn configure_startup_tasks(
  open_at_login: bool,
  run_as_admin: bool,
) -> napi::Result<StartupTaskSnapshot> {
  background(move || {
    let id = identity()?;
    if !id.elevated {
      return Err(Error::new(
        E_ACCESSDENIED,
        "startup configuration requires elevation",
      ));
    }
    let folder = scheduler()?;
    let before = snapshot(&folder, &id)?;
    let changed = (|| -> Result<()> {
      if run_as_admin {
        register(&folder, &id, "Launch", &task_xml(&id, false, true), None)?;
        register(
          &folder,
          &id,
          "Logon",
          &task_xml(&id, true, open_at_login),
          None,
        )?;
        for (hive, old) in [
          (HKEY_CURRENT_USER, &before.user_compat),
          (HKEY_LOCAL_MACHINE, &before.machine_compat),
        ] {
          if let Some(old) = old {
            let value = without_admin(old);
            if value != *old {
              write_compat(
                hive,
                &id.exe_path,
                if value.is_empty() { None } else { Some(&value) },
              )?;
            }
          }
        }
        let launch_state = probe_one(&folder, &id, false, true)?;
        let logon_state = probe_one(&folder, &id, true, open_at_login)?;
        if launch_state != "ok" || logon_state != "ok" {
          let diagnostics = format!(
            "registered startup tasks failed verification: Launch={launch_state}, Logon={logon_state}"
          );
          for (logon, enabled) in [(false, true), (true, open_at_login)] {
            if let Ok(details) = task_diagnostics(&folder, &id, logon, enabled) {
              crate::log::error(&details);
            }
          }
          return Err(invalid(diagnostics));
        }
      } else {
        delete(&folder, &task_name(&id, "Logon"))?;
        delete(&folder, &task_name(&id, "Launch"))?;
        if probe_one(&folder, &id, false, true)? != "absent"
          || probe_one(&folder, &id, true, true)? != "absent"
        {
          return Err(invalid("startup task removal failed verification"));
        }
      }
      Ok(())
    })();
    if let Err(error) = changed {
      restore(&folder, &id, &before)
        .map_err(|rollback| invalid(format!("{}; rollback failed: {}", error, rollback)))?;
      return Err(error);
    }
    Ok(before)
  })
  .await
}

#[napi(js_name = "restoreStartupTasks")]
pub async fn restore_startup_tasks(before: StartupTaskSnapshot) -> napi::Result<()> {
  background(move || {
    let id = identity()?;
    if !id.elevated {
      return Err(Error::new(
        E_ACCESSDENIED,
        "startup rollback requires elevation",
      ));
    }
    restore(&scheduler()?, &id, &before)
  })
  .await
}

#[napi(js_name = "runStartupTask")]
pub async fn run_startup_task(request_id: String) -> napi::Result<()> {
  background(move || {
    if !valid_request_id(&request_id) {
      return Err(invalid("invalid startup request id"));
    }
    let id = identity()?;
    let folder = scheduler()?;
    if probe_one(&folder, &id, false, true)? != "ok" {
      return Err(invalid("administrator launch task is missing or invalid"));
    }
    unsafe {
      let task = folder.GetTask(&BSTR::from(task_name(&id, "Launch")))?;
      task.RunEx(
        &VARIANT::from(request_id.as_str()),
        TASK_RUN_USE_SESSION_ID.0,
        id.session_id as i32,
        &BSTR::new(),
      )?;
    }
    // A successful RunEx is not an application-readiness acknowledgement.
    Ok(())
  })
  .await
}

fn valid_request_id(id: &str) -> bool {
  id.len() == 36
    && id.bytes().enumerate().all(|(i, b)| {
      if [8, 13, 18, 23].contains(&i) {
        b == b'-'
      } else {
        b.is_ascii_hexdigit()
      }
    })
}

#[napi(js_name = "launchStartupHelper")]
pub async fn launch_startup_helper(request_id: String) -> napi::Result<StartupHelperResult> {
  background(move || {
    if !valid_request_id(&request_id) {
      return Err(invalid("invalid startup request id"));
    }
    let id = identity()?;
    let exe: Vec<u16> = id.exe_path.encode_utf16().chain(Some(0)).collect();
    let args: Vec<u16> = format!("--vnite-startup-config={request_id}")
      .encode_utf16()
      .chain(Some(0))
      .collect();
    let mut info = SHELLEXECUTEINFOW {
      cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
      fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
      lpVerb: w!("runas"),
      lpFile: PCWSTR(exe.as_ptr()),
      lpParameters: PCWSTR(args.as_ptr()),
      nShow: 0,
      ..Default::default()
    };
    unsafe {
      ShellExecuteExW(&mut info)?;
      if info.hProcess.is_invalid() {
        return Err(invalid("elevated helper returned no process handle"));
      }
      let process = Handle(info.hProcess);
      if WaitForSingleObject(process.0, 300_000) != WAIT_OBJECT_0 {
        return Err(invalid("elevated configuration helper timed out"));
      }
      let mut exit_code = 1;
      GetExitCodeProcess(process.0, &mut exit_code)?;
      Ok(StartupHelperResult { exit_code })
    }
  })
  .await
}

#[napi(js_name = "removeInstallationStartupTasks")]
pub async fn remove_installation_startup_tasks() -> napi::Result<()> {
  background(move || {
    let id = identity()?;
    if !id.elevated {
      return Err(Error::new(
        E_ACCESSDENIED,
        "startup cleanup requires elevation",
      ));
    }
    unsafe {
      let folder = scheduler()?;
      let tasks = folder.GetTasks(TASK_ENUM_HIDDEN.0)?;
      let mut to_delete = Vec::new();
      for i in 1..=tasks.Count()? {
        let task = tasks.get_Item(&VARIANT::from(i))?;
        let name = task.Name()?.to_string();
        if (name.starts_with("Vnite-Launch-") || name.starts_with("Vnite-Logon-"))
          && name.ends_with(&format!("-{}", id.installation_id))
        {
          let fields = xml_values(&task.Xml()?.to_string())?;
          if fields
            .get("Task/Actions/Exec/Command")
            .is_some_and(|exe| normalize_path(exe) == normalize_path(&id.exe_path))
          {
            to_delete.push(name);
          }
        }
      }
      for name in to_delete {
        delete(&folder, &name)?;
      }
    }
    match std::fs::remove_file(Path::new(&id.state_directory).join("state.json")) {
      Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
        return Err(invalid(error.to_string()))
      }
      _ => {}
    }
    Ok(())
  })
  .await
}

fn task_diagnostics(
  folder: &ITaskFolder,
  id: &StartupIdentity,
  logon: bool,
  enabled: bool,
) -> Result<String> {
  unsafe {
    let name = task_name(id, if logon { "Logon" } else { "Launch" });
    let task = folder.GetTask(&BSTR::from(name.as_str()))?;
    let actual_xml = task.Xml()?.to_string();
    let actual = xml_values(&actual_xml)?;
    let expected = xml_values(&task_xml(id, logon, enabled))?;
    let differences: Vec<_> = expected
      .iter()
      .filter(|(key, value)| {
        !key.starts_with("Task/RegistrationInfo/")
          && actual
            .get(*key)
            .map(String::as_str)
            .or_else(|| task_xml_default(key))
            != Some(value.as_str())
      })
      .map(|(key, value)| format!("{key}: expected={value:?}, actual={:?}", actual.get(key)))
      .collect();
    let security = task.GetSecurityDescriptor(4)?.to_string();
    Ok(format!(
      "[AutoStart] {name}: XML differences={differences:?}; permissions_ok={}; security={security}; XML={actual_xml}",
      task_permissions(&security, &id.sid)?
    ))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  fn test_identity() -> StartupIdentity {
    StartupIdentity {
      sid: "S-1-5-21-123".into(),
      elevated: true,
      session_id: 1,
      exe_path: "C:\\Games & Apps\\Vnite\\Vnite.exe".into(),
      installation_id: "test".into(),
      state_directory: String::new(),
    }
  }
  #[test]
  fn task_validation_rejects_wrong_identity_and_settings() {
    let id = test_identity();
    let xml = task_xml(&id, false, true);
    assert_eq!(validate_task(&xml, &id, false, true).unwrap(), "ok");
    assert_eq!(
      validate_task(
        &xml.replace("InteractiveToken", "Password"),
        &id,
        false,
        true
      )
      .unwrap(),
      "wrong-logon-type"
    );
    assert_eq!(
      validate_task(
        &xml.replace("S-1-5-21-123", "S-1-5-21-456"),
        &id,
        false,
        true
      )
      .unwrap(),
      "wrong-principal"
    );
    assert_eq!(
      validate_task(&xml.replace("PT0S", "PT72H"), &id, false, true).unwrap(),
      "invalid-settings"
    );
    assert_eq!(
      validate_task(&task_xml(&id, true, false), &id, true, false).unwrap(),
      "ok"
    );
  }
  #[test]
  fn task_validation_accepts_windows_omitted_defaults() {
    let id = test_identity();
    for (logon, enabled) in [(false, true), (true, true), (true, false)] {
      let xml = task_xml(&id, logon, enabled)
        .replace("<Enabled>true</Enabled>", "")
        .replace("<AllowStartOnDemand>true</AllowStartOnDemand>", "");
      assert_eq!(validate_task(&xml, &id, logon, enabled).unwrap(), "ok");
    }
    let xml = task_xml(&id, false, true).replace(
      "<AllowStartOnDemand>true</AllowStartOnDemand>",
      "<AllowStartOnDemand>false</AllowStartOnDemand>",
    );
    assert_eq!(
      validate_task(&xml, &id, false, true).unwrap(),
      "invalid-settings"
    );
    let xml = task_xml(&id, true, false).replace("<Enabled>false</Enabled>", "");
    assert_eq!(
      validate_task(&xml, &id, true, false).unwrap(),
      "invalid-settings"
    );
    let xml = task_xml(&id, false, true).replace(
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "",
    );
    assert_eq!(
      validate_task(&xml, &id, false, true).unwrap(),
      "invalid-settings"
    );
  }
  #[test]
  fn compatibility_flags_preserve_other_options() {
    assert_eq!(without_admin("~ RUNASADMIN HIGHDPIAWARE"), "~ HIGHDPIAWARE");
    assert_eq!(without_admin("RUNASADMIN"), "");
    assert!(!has_admin_flag("~  WIN7RTM"));
    assert!(!valid_request_id("../request"));
    assert!(valid_request_id("00e6a041-2855-48c7-bdb6-fcc171282612"));
    assert_eq!(
      installation_id("C:\\Apps\\Vnite.exe"),
      installation_id("c:/apps/vnite.exe")
    );
  }
  #[test]
  fn task_permissions_allow_only_read_execute_for_the_account() {
    let sid = "S-1-5-21-123";
    assert!(
      task_permissions(&format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;{sid})"), sid).unwrap()
    );
    assert!(!task_permissions(&format!("D:(A;;GA;;;{sid})"), sid).unwrap());
    assert!(!task_permissions(&format!("D:(A;;GRGX;;;{sid})(A;;GA;;;WD)"), sid).unwrap());
  }

  #[test]
  #[ignore = "registers temporary tasks in the real Windows Task Scheduler"]
  fn registered_tasks_roundtrip() {
    std::thread::spawn(|| -> Result<()> {
      unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
      }
      let _apartment = ComApartment;
      let mut id = identity()?;
      if !id.elevated {
        return Err(Error::new(
          E_ACCESSDENIED,
          "integration test requires an elevated Windows runner",
        ));
      }
      id.installation_id = format!(
        "integration-{}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .unwrap()
          .as_nanos()
      );
      let folder = scheduler()?;
      let before = snapshot(&folder, &id)?;
      let result = (|| -> Result<()> {
        for (logon, enabled) in [(false, true), (true, false), (true, true)] {
          let kind = if logon { "Logon" } else { "Launch" };
          register(&folder, &id, kind, &task_xml(&id, logon, enabled), None)?;
          println!("{}", task_diagnostics(&folder, &id, logon, enabled)?);
          let state = probe_one(&folder, &id, logon, enabled)?;
          if state != "ok" {
            return Err(invalid(format!(
              "real {kind} task failed verification: {state}"
            )));
          }
        }
        Ok(())
      })();
      let cleanup = restore(&folder, &id, &before);
      result.and(cleanup)
    })
    .join()
    .expect("integration worker should not panic")
    .expect("Windows task registration must round-trip");
  }
}
