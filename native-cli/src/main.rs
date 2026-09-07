use serde_json::{json, Map, Value};
use std::{env, fs, process};
use url::Url;

const HELP: &str = r#"SAFS native CLI
Usage:
  safs [--config CONNECTION.json] bind [--cwd LOCAL_CWD]
  safs [--config CONNECTION.json] list|read|search --binding ID [options]
  safs [--config CONNECTION.json] edit|upload|download|move|chmod|delete|read-many --binding ID --input 'JSON'
  safs [--config CONNECTION.json] write --binding ID --path PATH --file UTF8_FILE
  safs [--config CONNECTION.json] exec --binding ID [--cwd REMOTE_CWD] -- REMOTE_COMMAND
  safs [--config CONNECTION.json] output --binding ID --id ID --stream stdout|stderr [--offset N] [--length N]
  safs [--config CONNECTION.json] batch --binding ID --input '{"operations":[...]}'
  safs [--config CONNECTION.json] workspaces
  safs [--config CONNECTION.json] switch --workspace ID --confirmed true

Advanced list/read/search options may be supplied with --input as inline JSON,
e.g. --input '{"path":"src","limit":20}'. The input must not contain bindingId
or mountName. Bindings are explicit and never recover or switch automatically.
Use --compact to omit routine success metadata. Errors are concise by default;
use --verbose to print their complete structured result.
"#;

fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    if let Some(index) = args.iter().position(|arg| arg == name) {
        if index + 1 >= args.len() {
            return Err(format!("{name} requires a value"));
        }
        let value = args.remove(index + 1);
        args.remove(index);
        Ok(Some(value))
    } else {
        Ok(None)
    }
}

fn parse_u64(value: &str, name: &str) -> Result<Value, String> {
    value
        .parse::<u64>()
        .map(Value::from)
        .map_err(|_| format!("Invalid {name}"))
}

fn request(mut args: Vec<String>, cwd: String) -> Result<(String, Value), String> {
    if args.is_empty() {
        return Err("Missing command; use --help".into());
    }
    let verb = args.remove(0);
    let input_json = take_option(&mut args, "--input")?;
    let content_path = take_option(&mut args, "--file")?;
    let mut values = Map::new();
    if let Some(json) = input_json {
        let input: Value = serde_json::from_str(&json).map_err(|_| "Invalid --input JSON")?;
        let object = input
            .as_object()
            .ok_or("--input must contain a JSON object")?;
        if object.contains_key("bindingId") || object.contains_key("mountName") {
            return Err("--input must not override bindingId or mountName".into());
        }
        values.extend(object.clone());
    }
    let allowed = match verb.as_str() {
        "bind" => &["cwd"][..],
        "workspaces" => &[],
        "switch" => &["workspace", "confirmed"],
        "list" => &["binding", "path", "limit", "cursor"],
        "read" => &[
            "binding",
            "path",
            "offset",
            "length",
            "head",
            "tail",
            "start-line",
            "line-count",
        ],
        "search" => &["binding", "path", "query", "mode"],
        "edit" | "write" | "delete" | "chmod" => &["binding", "path", "mode"],
        "upload" | "download" | "move" | "read-many" | "batch" => &["binding"],
        "output" => &["binding", "id", "stream", "offset", "length"],
        "exec" => &["binding", "cwd"],
        _ => return Err("Unknown command; use --help".into()),
    };
    let mut remote_command = None;
    while !args.is_empty() {
        if args[0] == "--" {
            args.remove(0);
            if verb != "exec" || args.len() != 1 {
                return Err("Pass one remote command after --".into());
            }
            remote_command = Some(args.remove(0));
            break;
        }
        let flag = args.remove(0);
        if !flag.starts_with("--") || args.is_empty() {
            return Err(format!("Invalid option: {flag}"));
        }
        let key = &flag[2..];
        if !allowed.contains(&key) {
            return Err(format!("Invalid option for {verb}: {flag}"));
        }
        let value = args.remove(0);
        let json_key = match key {
            "start-line" => "startLine",
            "line-count" => "lineCount",
            _ => key,
        };
        if values.contains_key(json_key) {
            return Err(format!("Duplicate input field: {json_key}"));
        }
        let value = if [
            "limit",
            "offset",
            "length",
            "head",
            "tail",
            "start-line",
            "line-count",
        ]
        .contains(&key)
        {
            parse_u64(&value, &flag)?
        } else {
            Value::String(value)
        };
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
                let workspace = values
                    .remove("workspace")
                    .ok_or("--workspace is required")?;
                if values.remove("confirmed") != Some(Value::String("true".into())) {
                    return Err("--confirmed true is required after user confirmation".into());
                }
                values.insert("workspaceId".into(), workspace);
                values.insert("userConfirmed".into(), Value::Bool(true));
            }
            "safs_switch_remote_workspace"
        }
        "batch" => {
            let binding = binding.ok_or("--binding is required")?;
            let operations = values
                .remove("operations")
                .and_then(|value| value.as_array().cloned())
                .ok_or("batch --input must contain an operations array")?;
            if operations.is_empty() || operations.len() > 50 {
                return Err("batch requires 1 to 50 operations".into());
            }
            let mut normalized = Vec::with_capacity(operations.len());
            for operation in operations {
                let object = operation
                    .as_object()
                    .ok_or("Each batch operation must be an object")?;
                let command = object
                    .get("command")
                    .and_then(Value::as_str)
                    .ok_or("Each batch operation requires command")?;
                let name = match command {
                    "list" => "remote_list",
                    "read" => "remote_read",
                    "read-many" => "remote_read_many",
                    "search" => "remote_search",
                    "edit" => "remote_edit",
                    "write" => "remote_write",
                    "delete" => "remote_delete",
                    "chmod" => "remote_chmod",
                    "move" => "remote_move",
                    "upload" => "remote_upload",
                    "download" => "remote_download",
                    "output" => "remote_output",
                    "exec" => "run_remote_command",
                    _ => return Err(format!("Unsupported batch command: {command}")),
                };
                let mut arguments = object
                    .get("arguments")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if arguments.contains_key("bindingId") || arguments.contains_key("mountName") {
                    return Err("Batch arguments must not override bindingId or mountName".into());
                }
                arguments.insert("bindingId".into(), binding.clone());
                normalized.push(json!({ "name": name, "arguments": arguments }));
            }
            values.clear();
            values.insert("operations".into(), Value::Array(normalized));
            "safs_cli_batch"
        }
        _ => {
            values.insert("bindingId".into(), binding.ok_or("--binding is required")?);
            match verb.as_str() {
                "list" => "remote_list",
                "read" => "remote_read",
                "read-many" => "remote_read_many",
                "search" => "remote_search",
                "edit" => "remote_edit",
                "write" => "remote_write",
                "delete" => "remote_delete",
                "chmod" => "remote_chmod",
                "move" => "remote_move",
                "upload" => "remote_upload",
                "download" => "remote_download",
                "output" => {
                    let output_id = values.remove("id").ok_or("--id is required")?;
                    values.insert("outputId".into(), output_id);
                    if !matches!(
                        values.get("stream").and_then(Value::as_str),
                        Some("stdout" | "stderr")
                    ) {
                        return Err("--stream stdout|stderr is required".into());
                    }
                    "remote_output"
                }
                "exec" => {
                    values.insert(
                        "command".into(),
                        Value::String(
                            remote_command
                                .filter(|s| !s.trim().is_empty())
                                .ok_or("Remote command is required")?,
                        ),
                    );
                    if let Some(cwd) = values.remove("cwd") {
                        values.insert("remoteCwd".into(), cwd);
                    }
                    "run_remote_command"
                }
                _ => unreachable!(),
            }
        }
    };
    if let Some(path) = content_path {
        if tool != "remote_write" {
            return Err("--file is only valid for write".into());
        }
        values.insert(
            "content".into(),
            Value::String(fs::read_to_string(path).map_err(|_| "Cannot read UTF-8 --file")?),
        );
    }
    Ok((tool.into(), Value::Object(values)))
}

fn invoke(config_path: &str, name: String, arguments: Value) -> Result<Value, String> {
    let config: Value = serde_json::from_str(
        &fs::read_to_string(config_path).map_err(|_| "Cannot read SAFS connection file")?,
    )
    .map_err(|_| "Invalid SAFS connection file")?;
    if config.get("version") != Some(&Value::from(1)) {
        return Err("Unsupported SAFS connection file".into());
    }
    let raw_url = config
        .get("url")
        .and_then(Value::as_str)
        .ok_or("Connection URL is missing")?;
    let mut url = Url::parse(raw_url).map_err(|_| "Invalid SAFS connection URL")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
        || url
            .query_pairs()
            .all(|(key, value)| key != "token" || value.is_empty())
    {
        return Err("SAFS connection must be an authenticated loopback URL".into());
    }
    url.set_path("/cli");
    let mut response = ureq::post(url.as_str())
        .header("content-type", "application/json")
        .send_json(json!({ "name": name, "arguments": arguments }))
        .map_err(|_| "Cannot connect to the local SAFS router")?;
    let envelope: Value = response
        .body_mut()
        .read_json()
        .map_err(|_| "Invalid response from SAFS router")?;
    envelope
        .get("result")
        .cloned()
        .ok_or("SAFS router returned no result".into())
}

fn result_exit_code(result: &Value) -> i32 {
    let error_code = result.get("code").and_then(Value::as_str);
    let item_failed = result
        .get("results")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("ok") == Some(&Value::Bool(false))
                    || item.get("status").and_then(Value::as_str) == Some("error")
                    || item
                        .get("result")
                        .and_then(|nested| nested.get("exitCode"))
                        .and_then(Value::as_i64)
                        .is_some_and(|code| code != 0)
            })
        });
    result
        .get("exitCode")
        .and_then(Value::as_i64)
        .filter(|code| (0..=255).contains(code))
        .unwrap_or_else(|| {
            if (error_code.is_some() && error_code != Some("WORKSPACE_SELECTION_REQUIRED"))
                || result.get("status").and_then(Value::as_str) == Some("error")
                || item_failed
            {
                1
            } else {
                0
            }
        }) as i32
}

fn compact_result(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(compact_result),
        Value::Object(object) => {
            object.values_mut().for_each(compact_result);
            object.retain(|key, value| {
                let routine_status = key == "status" && value.as_str() == Some("ok");
                let routine_success = key == "ok" && value.as_bool() == Some(true);
                let routine_false = matches!(key.as_str(), "truncated" | "hasMore")
                    && value.as_bool() == Some(false);
                !routine_status && !routine_success && !routine_false
            });
        }
        _ => {}
    }
}

fn concise_error(result: &Value) -> String {
    if let Some(failed) = result
        .get("results")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("ok") == Some(&Value::Bool(false)))
        })
    {
        let index = failed.get("index").and_then(Value::as_u64).unwrap_or(0);
        let detail = failed
            .get("result")
            .map(concise_error)
            .unwrap_or_else(|| "operation failed".into());
        return format!("batch[{index}]: {detail}");
    }
    let code = result.get("code").and_then(Value::as_str);
    let message = result
        .get("message")
        .or_else(|| result.get("error"))
        .and_then(Value::as_str);
    match (code, message) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (Some(code), None) => code.into(),
        (None, Some(message)) => message.into(),
        _ => "SAFS operation failed".into(),
    }
}

fn run() -> Result<i32, String> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(0);
    }
    let compact = args.iter().any(|arg| arg == "--compact");
    let verbose = args.iter().any(|arg| arg == "--verbose");
    args.retain(|arg| arg != "--compact" && arg != "--verbose");
    let config = take_option(&mut args, "--config")?
        .or_else(|| env::var("SAFS_CONFIG").ok())
        .or_else(|| {
            env::current_exe().ok().and_then(|value| {
                value.parent().map(|parent| {
                    parent
                        .join(".safs-connection.json")
                        .to_string_lossy()
                        .into_owned()
                })
            })
        })
        .ok_or("Cannot locate the SAFS connection file")?;
    let (name, arguments) = request(
        args,
        env::current_dir()
            .map_err(|_| "Cannot determine current directory")?
            .to_string_lossy()
            .into(),
    )?;
    let mut result = invoke(&config, name.clone(), arguments)?;
    let code = result_exit_code(&result);
    if code != 0 && name != "run_remote_command" {
        return Err(if verbose {
            serde_json::to_string(&result).unwrap_or_else(|_| "SAFS operation failed".into())
        } else {
            concise_error(&result)
        });
    }
    if compact {
        compact_result(&mut result);
    }
    if name == "run_remote_command" {
        if let Some(text) = result.get("stdout").and_then(Value::as_str) {
            print!("{text}");
        }
        if let Some(text) = result.get("stderr").and_then(Value::as_str) {
            eprint!("{text}");
        }
        if result.get("truncated") == Some(&Value::Bool(true)) {
            eprintln!("\n{}", json!({"safsOutput": result}));
        }
    } else {
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|_| "Cannot encode SAFS result")?
        );
    }
    Ok(code)
}

fn main() {
    match run() {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("SAFS: {error}");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_structured_and_exact_command_arguments() {
        let (name, args) = request(
            vec![
                "read",
                "--binding",
                "id",
                "--path",
                "a",
                "--start-line",
                "2",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(name, "remote_read");
        assert_eq!(args["startLine"], 2);
        let command = "printf '%s' \"$(pwd)\"";
        let (_, args) = request(
            vec!["exec", "--binding", "id", "--", command]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(args["command"], command);
    }
    #[test]
    fn never_accepts_binding_override_or_unconfirmed_switch() {
        let inline = r#"{"bindingId":"other"}"#;
        let result = request(
            vec!["read", "--binding", "id", "--input", inline]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into(),
        );
        assert!(result.is_err());
        assert!(request(
            vec!["switch", "--workspace", "id"]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into()
        )
        .is_err());
    }
    #[test]
    fn accepts_inline_json_input() {
        let inline = request(
            vec![
                "list",
                "--binding",
                "id",
                "--input",
                r#"{"path":"gm_tests","limit":10}"#,
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(inline.1["path"], "gm_tests");
        assert_eq!(inline.1["limit"], 10);
        let bad = request(
            vec!["list", "--binding", "id", "--input", "not-json"]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into(),
        );
        assert!(bad.is_err());
    }
    #[test]
    fn propagates_command_search_and_batch_failure_status() {
        assert_eq!(result_exit_code(&json!({"exitCode": 7})), 7);
        assert_eq!(result_exit_code(&json!({"status": "error"})), 1);
        assert_eq!(
            result_exit_code(&json!({"results": [{"status": "ok"}, {"status": "error"}]})),
            1
        );
        assert_eq!(
            result_exit_code(&json!({"results": [{"ok": false, "result": {"code": "FAILED"}}]})),
            1
        );
        assert_eq!(
            result_exit_code(&json!({"code": "WORKSPACE_SELECTION_REQUIRED"})),
            0
        );
    }
    #[test]
    fn builds_batches_and_compacts_routine_metadata() {
        let input = r#"{"operations":[{"command":"read","arguments":{"path":"a"}},{"command":"search","arguments":{"query":"TODO"}}]}"#;
        let (name, args) = request(
            vec!["batch", "--binding", "id", "--input", input]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(name, "safs_cli_batch");
        assert_eq!(args["operations"][0]["arguments"]["bindingId"], "id");
        let mut result = json!({"status":"ok","truncated":false,"hasMore":false,"content":"x"});
        compact_result(&mut result);
        assert_eq!(result, json!({"content":"x"}));
    }
}
