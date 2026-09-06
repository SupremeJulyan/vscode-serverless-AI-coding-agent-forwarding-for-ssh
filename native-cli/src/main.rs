use serde_json::{json, Map, Value};
use std::{env, fs, process};
use url::Url;

const HELP: &str = r#"SAFS native CLI
Usage:
  safs [--config CONNECTION.json] bind [--cwd LOCAL_CWD]
  safs [--config CONNECTION.json] list|read|search --binding ID [options]
  safs [--config CONNECTION.json] edit|upload|download|move|chmod|delete|read-many --binding ID --input OPTIONS.json
  safs [--config CONNECTION.json] write --binding ID --path PATH --file UTF8_FILE
  safs [--config CONNECTION.json] exec --binding ID [--cwd REMOTE_CWD] -- REMOTE_COMMAND
  safs [--config CONNECTION.json] output --binding ID --id ID --stream stdout|stderr [--offset N] [--length N]
  safs [--config CONNECTION.json] workspaces
  safs [--config CONNECTION.json] switch --workspace ID --confirmed true

Advanced list/read/search options may be supplied with --input JSON. The input
must not contain bindingId or mountName. Bindings are explicit and never recover
or switch automatically.
"#;

fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    if let Some(index) = args.iter().position(|arg| arg == name) {
        if index + 1 >= args.len() { return Err(format!("{name} requires a value")); }
        let value = args.remove(index + 1);
        args.remove(index);
        Ok(Some(value))
    } else { Ok(None) }
}

fn parse_u64(value: &str, name: &str) -> Result<Value, String> {
    value.parse::<u64>().map(Value::from).map_err(|_| format!("Invalid {name}"))
}

fn request(mut args: Vec<String>, cwd: String) -> Result<(String, Value), String> {
    if args.is_empty() { return Err("Missing command; use --help".into()); }
    let verb = args.remove(0);
    let input_path = take_option(&mut args, "--input")?;
    let content_path = take_option(&mut args, "--file")?;
    let mut values = Map::new();
    if let Some(path) = input_path {
        let input: Value = serde_json::from_str(&fs::read_to_string(path).map_err(|_| "Cannot read --input file")?)
            .map_err(|_| "Invalid --input JSON")?;
        let object = input.as_object().ok_or("--input must contain a JSON object")?;
        if object.contains_key("bindingId") || object.contains_key("mountName") {
            return Err("--input must not override bindingId or mountName".into());
        }
        values.extend(object.clone());
    }
    let allowed = match verb.as_str() {
        "bind" => &["cwd"][..], "workspaces" => &[], "switch" => &["workspace", "confirmed"],
        "list" => &["binding", "path", "limit", "cursor"],
        "read" => &["binding", "path", "offset", "length", "head", "tail", "start-line", "line-count"],
        "search" => &["binding", "path", "query", "mode"],
        "edit" | "write" | "delete" | "chmod" => &["binding", "path", "mode"],
        "upload" | "download" | "move" | "read-many" => &["binding"],
        "output" => &["binding", "id", "stream", "offset", "length"],
        "exec" => &["binding", "cwd"], _ => return Err("Unknown command; use --help".into()),
    };
    let mut remote_command = None;
    while !args.is_empty() {
        if args[0] == "--" {
            args.remove(0);
            if verb != "exec" || args.len() != 1 { return Err("Pass one remote command after --".into()); }
            remote_command = Some(args.remove(0));
            break;
        }
        let flag = args.remove(0);
        if !flag.starts_with("--") || args.is_empty() { return Err(format!("Invalid option: {flag}")); }
        let key = &flag[2..];
        if !allowed.contains(&key) { return Err(format!("Invalid option for {verb}: {flag}")); }
        let value = args.remove(0);
        let json_key = match key { "start-line" => "startLine", "line-count" => "lineCount", _ => key };
        if values.contains_key(json_key) { return Err(format!("Duplicate input field: {json_key}")); }
        let value = if ["limit", "offset", "length", "head", "tail", "start-line", "line-count"].contains(&key) {
            parse_u64(&value, &flag)?
        } else { Value::String(value) };
        values.insert(json_key.into(), value);
    }
    let binding = values.remove("binding");
    let tool = match verb.as_str() {
        "bind" => {
            let agent_cwd = values.remove("cwd").unwrap_or(Value::String(cwd));
            values.insert("agentCwd".into(), agent_cwd);
            "safs_get_remote_workspace"
        }
        "workspaces" | "switch" => {
            if verb == "switch" {
                let workspace = values.remove("workspace").ok_or("--workspace is required")?;
                if values.remove("confirmed") != Some(Value::String("true".into())) { return Err("--confirmed true is required after user confirmation".into()); }
                values.insert("workspaceId".into(), workspace);
                values.insert("userConfirmed".into(), Value::Bool(true));
            }
            "safs_switch_remote_workspace"
        }
        _ => {
            values.insert("bindingId".into(), binding.ok_or("--binding is required")?);
            match verb.as_str() {
                "list" => "remote_list", "read" => "remote_read", "read-many" => "remote_read_many",
                "search" => "remote_search", "edit" => "remote_edit", "write" => "remote_write",
                "delete" => "remote_delete", "chmod" => "remote_chmod", "move" => "remote_move",
                "upload" => "remote_upload", "download" => "remote_download", "output" => {
                    let output_id = values.remove("id").ok_or("--id is required")?;
                    values.insert("outputId".into(), output_id);
                    if !matches!(values.get("stream").and_then(Value::as_str), Some("stdout" | "stderr")) { return Err("--stream stdout|stderr is required".into()); }
                    "remote_output"
                }
                "exec" => {
                    values.insert("command".into(), Value::String(remote_command.filter(|s| !s.trim().is_empty()).ok_or("Remote command is required")?));
                    if let Some(cwd) = values.remove("cwd") { values.insert("remoteCwd".into(), cwd); }
                    "run_remote_command"
                }
                _ => unreachable!(),
            }
        }
    };
    if let Some(path) = content_path {
        if tool != "remote_write" { return Err("--file is only valid for write".into()); }
        values.insert("content".into(), Value::String(fs::read_to_string(path).map_err(|_| "Cannot read UTF-8 --file")?));
    }
    Ok((tool.into(), Value::Object(values)))
}

fn invoke(config_path: &str, name: String, arguments: Value) -> Result<Value, String> {
    let config: Value = serde_json::from_str(&fs::read_to_string(config_path).map_err(|_| "Cannot read SAFS connection file")?)
        .map_err(|_| "Invalid SAFS connection file")?;
    if config.get("version") != Some(&Value::from(1)) { return Err("Unsupported SAFS connection file".into()); }
    let raw_url = config.get("url").and_then(Value::as_str).ok_or("Connection URL is missing")?;
    let mut url = Url::parse(raw_url).map_err(|_| "Invalid SAFS connection URL")?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
        || url.query_pairs().all(|(key, value)| key != "token" || value.is_empty()) {
        return Err("SAFS connection must be an authenticated loopback URL".into());
    }
    url.set_path("/cli");
    let mut response = ureq::post(url.as_str()).header("content-type", "application/json")
        .send_json(json!({ "name": name, "arguments": arguments })).map_err(|_| "Cannot connect to the local SAFS router")?;
    let envelope: Value = response.body_mut().read_json().map_err(|_| "Invalid response from SAFS router")?;
    let result = envelope.get("result").cloned().ok_or("SAFS router returned no result")?;
    if envelope.get("ok") != Some(&Value::Bool(true))
        && result.get("code").and_then(Value::as_str) != Some("WORKSPACE_SELECTION_REQUIRED") {
        return Err(serde_json::to_string(&result).unwrap_or_else(|_| "SAFS operation failed".into()));
    }
    Ok(result)
}

fn result_exit_code(result: &Value) -> i32 {
    let item_failed = result.get("results").and_then(Value::as_array).is_some_and(|items|
        items.iter().any(|item| item.get("status").and_then(Value::as_str) == Some("error"))
    );
    result.get("exitCode").and_then(Value::as_i64)
        .filter(|code| (0..=255).contains(code))
        .unwrap_or_else(|| if result.get("status").and_then(Value::as_str) == Some("error") || item_failed { 1 } else { 0 }) as i32
}

fn run() -> Result<i32, String> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") { print!("{HELP}"); return Ok(0); }
    let config = take_option(&mut args, "--config")?
        .or_else(|| env::var("SAFS_CONFIG").ok()).ok_or("Use --config CONNECTION.json or SAFS_CONFIG")?;
    let (name, arguments) = request(args, env::current_dir().map_err(|_| "Cannot determine current directory")?.to_string_lossy().into())?;
    let result = invoke(&config, name.clone(), arguments)?;
    if name == "run_remote_command" {
        if let Some(text) = result.get("stdout").and_then(Value::as_str) { print!("{text}"); }
        if let Some(text) = result.get("stderr").and_then(Value::as_str) { eprint!("{text}"); }
        if result.get("truncated") == Some(&Value::Bool(true)) { eprintln!("\n{}", json!({"safsOutput": result})); }
    } else { println!("{}", serde_json::to_string(&result).map_err(|_| "Cannot encode SAFS result")?); }
    Ok(result_exit_code(&result))
}

fn main() {
    match run() { Ok(code) => process::exit(code), Err(error) => { eprintln!("SAFS: {error}"); process::exit(1); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_structured_and_exact_command_arguments() {
        let (name, args) = request(vec!["read", "--binding", "id", "--path", "a", "--start-line", "2"].into_iter().map(String::from).collect(), "/cwd".into()).unwrap();
        assert_eq!(name, "remote_read"); assert_eq!(args["startLine"], 2);
        let command = "printf '%s' \"$(pwd)\"";
        let (_, args) = request(vec!["exec", "--binding", "id", "--", command].into_iter().map(String::from).collect(), "/cwd".into()).unwrap();
        assert_eq!(args["command"], command);
    }
    #[test]
    fn never_accepts_binding_override_or_unconfirmed_switch() {
        let file = env::temp_dir().join(format!("safs-test-{}.json", process::id()));
        fs::write(&file, r#"{"bindingId":"other"}"#).unwrap();
        let result = request(vec!["read", "--binding", "id", "--input", file.to_str().unwrap()].into_iter().map(String::from).collect(), "/cwd".into());
        fs::remove_file(file).ok(); assert!(result.is_err());
        assert!(request(vec!["switch", "--workspace", "id"].into_iter().map(String::from).collect(), "/cwd".into()).is_err());
    }
    #[test]
    fn propagates_command_search_and_batch_failure_status() {
        assert_eq!(result_exit_code(&json!({"exitCode": 7})), 7);
        assert_eq!(result_exit_code(&json!({"status": "error"})), 1);
        assert_eq!(result_exit_code(&json!({"results": [{"status": "ok"}, {"status": "error"}]})), 1);
        assert_eq!(result_exit_code(&json!({"code": "WORKSPACE_SELECTION_REQUIRED"})), 0);
    }
}
