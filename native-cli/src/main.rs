use serde_json::{json, Map, Value};
use std::{
    env, fs,
    io::{self, Read},
    process,
    time::Duration,
};
use url::Url;

const HELP: &str = r#"Usage: safs COMMAND [options]

Workspace: bind, workspaces, switch, current-file
Read:      list, read, read-many, search, find, output
Write:     edit, write, delete, chmod, move, upload, download
Execute:   exec, batch

Run `safs COMMAND --help` for exact arguments and JSON examples.
Global options: --compact, --verbose
"#;

fn command_help(command: &str) -> Option<&'static str> {
    match command {
        "bind" => Some(
            r#"Usage: safs bind [--cwd LOCAL_CWD]
Matches the current cwd (or --cwd) to a SAFS placeholder. If none matches,
the uniquely focused workspace is used; otherwise candidates are returned.
"#,
        ),
        "workspaces" => Some(
            r#"Usage: safs workspaces
Lists all active SAFS workspaces and their workspaceId values.
"#,
        ),
        "switch" => Some(
            r#"Usage: safs switch --workspace ID --confirmed
Call only after the user explicitly chooses a workspace. Returns a new bindingId.
"#,
        ),
        "current-file" => Some(
            r#"Usage: safs current-file --binding ID
Returns the active remote editor file, or null when no remote file is open.
"#,
        ),
        "list" => Some(
            r#"Usage: safs list --binding ID [--path PATH] [--limit N] [--cursor CURSOR]
Batch form: safs list --binding ID --input '{"paths":["src","test"],"limit":100}'
"#,
        ),
        "read" => Some(
            r#"Usage: safs read --binding ID --path PATH [selection]
Selection: --offset N [--length N] | --head N | --tail N |
           --start-line N [--line-count N]
"#,
        ),
        "read-many" => Some(
            r#"Usage: safs read-many --binding ID --input JSON|-
Example: --input '{"requests":[{"path":"a.txt"},{"path":"b.txt","head":20}],"maxBytes":16384}'
"#,
        ),
        "search" => Some(
            r#"Usage: safs search --binding ID --query QUERY [--path PATH] [--mode content|files|count|names]
       safs search --binding ID --name GLOB [--path PATH]
files returns paths of files whose CONTENT matches; names matches file BASENAMES.
Advanced filters use --input JSON: fixedStrings, ignoreCase, contextLines, include,
and excludeDirs.
"#,
        ),
        "find" => Some(
            r#"Usage: safs find --binding ID --name GLOB [--path PATH]
Finds files by basename. GLOB uses shell-style patterns such as '*.ts'.
Equivalent to: safs search --binding ID --query GLOB --mode names
"#,
        ),
        "edit" => Some(
            r#"Usage: safs edit --binding ID --path PATH --input JSON|-
Example: --input '{"edits":[{"oldText":"old","newText":"new"}],"expectedHash":"SHA256"}'
"#,
        ),
        "write" => Some(
            r#"Usage: safs write --binding ID --path PATH (--file LOCAL_UTF8_FILE|- | --content TEXT)
--content is convenient for short, non-sensitive text. Use --file - for multiline
or sensitive content so it does not appear in command arguments.
"#,
        ),
        "delete" => Some(
            r#"Usage: safs delete --binding ID --path PATH [--input '{"recursive":true}']
recursive=true is required for a non-empty directory.
"#,
        ),
        "chmod" => Some(
            r#"Usage: safs chmod --binding ID --path PATH --mode MODE
MODE is exactly three octal digits, for example 644 or 755.
"#,
        ),
        "move" => Some(
            r#"Usage: safs move --binding ID --input JSON|-
Example: --input '{"sourcePath":"old","targetPath":"new","overwrite":false}'
"#,
        ),
        "upload" => Some(
            r#"Usage: safs upload --binding ID --input JSON|-
Example: --input '{"localPaths":["/absolute/local/path"],"remoteDirectory":"."}'
"#,
        ),
        "download" => Some(
            r#"Usage: safs download --binding ID --input JSON|-
Example: --input '{"remotePath":"file","localPath":"/absolute/local/target"}'
"#,
        ),
        "exec" => Some(
            r#"Usage: safs exec --binding ID [--cwd REMOTE_CWD] -- 'REMOTE_COMMAND'
       safs exec --binding ID [--cwd REMOTE_CWD] --command 'REMOTE_COMMAND'
The complete remote command must be passed as one shell argument.
"#,
        ),
        "output" => Some(
            r#"Usage: safs output --binding ID --id ID --stream stdout|stderr [--offset N] [--length N]
Continues a retained, truncated command stream without rerunning the command.
"#,
        ),
        "batch" => Some(
            r#"Usage: safs batch --binding ID --input JSON|-
Example: --input '{"operations":[{"command":"read","arguments":{"path":"README.md"}}]}'
Runs 1 to 50 operations sequentially in one local HTTP request.
"#,
        ),
        _ => None,
    }
}

fn requested_help(args: &[String]) -> Option<Option<&str>> {
    let boundary = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut command = None;
    let mut index = 0;
    while index < boundary {
        let arg = &args[index];
        if arg == "--help" || arg == "-h" {
            return Some(command);
        }
        if !arg.starts_with('-') && command.is_none() {
            command = Some(arg.as_str());
            index += 1;
            continue;
        }
        // Skip option values so aliases such as `--command '--help'` and
        // `--content '-h'` remain data rather than triggering CLI help.
        if arg.starts_with("--")
            && !matches!(arg.as_str(), "--compact" | "--verbose" | "--confirmed")
        {
            index += 2;
        } else {
            index += 1;
        }
    }
    None
}

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

fn usage_error(command: Option<&str>, error: String) -> String {
    format!(
        "{error}\n\n{}",
        command.and_then(command_help).unwrap_or(HELP).trim_end()
    )
}

#[cfg(test)]
fn request(args: Vec<String>, cwd: String) -> Result<(String, Value), String> {
    request_with_context(args, cwd, None)
}

fn request_with_context(
    args: Vec<String>,
    cwd: String,
    stdin_content: Option<String>,
) -> Result<(String, Value), String> {
    let command = args.first().cloned();
    parse_request(args, cwd, stdin_content)
        .map_err(|error| usage_error(command.as_deref(), error))
}

fn parse_request(
    mut args: Vec<String>,
    cwd: String,
    stdin_content: Option<String>,
) -> Result<(String, Value), String> {
    if args.is_empty() {
        return Err("Missing command; use --help".into());
    }
    let verb = args.remove(0);
    let input_json = take_option(&mut args, "--input")?;
    let content_path = take_option(&mut args, "--file")?;
    if input_json.as_deref() == Some("-") && content_path.as_deref() == Some("-") {
        return Err("--input - and --file - cannot read the same stdin".into());
    }
    let input_json = input_json
        .map(|value| {
            if value == "-" {
                stdin_content.clone().ok_or("Cannot read UTF-8 stdin")
            } else {
                Ok(value)
            }
        })
        .transpose()?;
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
        "current-file" => &["binding"],
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
        "search" => &["binding", "path", "query", "name", "mode"],
        "find" => &["binding", "path", "name"],
        "edit" => &["binding", "path"],
        "write" => &["binding", "path", "content"],
        "delete" => &["binding", "path"],
        "chmod" => &["binding", "path", "mode"],
        "upload" | "download" | "move" | "read-many" | "batch" => &["binding"],
        "output" => &["binding", "id", "stream", "offset", "length"],
        "exec" => &["binding", "cwd", "command"],
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
        if verb == "switch" && flag == "--confirmed" {
            if values.contains_key("confirmed") {
                return Err("Duplicate input field: confirmed".into());
            }
            if args.first().is_some_and(|value| value == "true") {
                args.remove(0);
            } else if args.first().is_some_and(|value| value == "false") {
                return Err("--confirmed cannot be false".into());
            }
            values.insert("confirmed".into(), Value::Bool(true));
            continue;
        }
        if !flag.starts_with("--") {
            return Err(format!("Invalid option: {flag}"));
        }
        if args.is_empty() {
            return Err(format!("{flag} requires a value"));
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
    if matches!(verb.as_str(), "search" | "find") {
        if let Some(name) = values.remove("name") {
            if values.contains_key("query") {
                return Err("Use either --query or --name, not both".into());
            }
            if let Some(mode) = values.get("mode").and_then(Value::as_str) {
                if mode != "names" {
                    return Err("--name requires --mode names; omit --mode to select it automatically".into());
                }
            }
            values.insert("query".into(), name);
            values.insert("mode".into(), Value::String("names".into()));
        }
        if verb == "find" {
            if !values.contains_key("query") {
                return Err("--name is required. Example: safs find --binding ID --name '*.ts'".into());
            }
            values.insert("mode".into(), Value::String("names".into()));
        }
        if !values.contains_key("query") {
            return Err("Search query is required. Use --query for contents or --name for filenames".into());
        }
        if values
            .get("mode")
            .and_then(Value::as_str)
            .is_some_and(|mode| !["content", "files", "count", "names"].contains(&mode))
        {
            return Err("--mode must be content, files, count, or names".into());
        }
    }
    let binding = values.remove("binding");
    let require_binding = || {
        "--binding is required. Use the bindingId returned by `safs bind` or `safs switch`.".to_string()
    };
    let tool = match verb.as_str() {
        "bind" => {
            let agent_cwd = values.remove("cwd").unwrap_or(Value::String(cwd));
            values.insert("agentCwd".into(), agent_cwd);
            "safs_get_remote_workspace"
        }
        "workspaces" => "cli_list_workspaces",
        "switch" => {
            let workspace = values
                .remove("workspace")
                .ok_or("--workspace is required")?;
            if values.remove("confirmed") != Some(Value::Bool(true)) {
                return Err("--confirmed is required after user confirmation".into());
            }
            values.insert("workspaceId".into(), workspace);
            values.insert("userConfirmed".into(), Value::Bool(true));
            "safs_switch_remote_workspace"
        }
        "batch" => {
            let binding = binding.ok_or_else(&require_binding)?;
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
                    "current-file" => "current_remote_file",
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
            values.insert("bindingId".into(), binding.ok_or_else(&require_binding)?);
            match verb.as_str() {
                "current-file" => "current_remote_file",
                "list" => "remote_list",
                "read" => "remote_read",
                "read-many" => "remote_read_many",
                "search" | "find" => "remote_search",
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
                    let option_command = values
                        .remove("command")
                        .and_then(|value| value.as_str().map(str::to_owned));
                    if remote_command.is_some() && option_command.is_some() {
                        return Err("Use either --command or --, not both".into());
                    }
                    values.insert(
                        "command".into(),
                        Value::String(
                            remote_command.or(option_command)
                                .filter(|s| !s.trim().is_empty())
                                .ok_or("Remote command is required. Retry with `safs exec --binding ID -- 'COMMAND'` or `--command 'COMMAND'`")?,
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
        let content = if path == "-" {
            stdin_content.ok_or("Cannot read UTF-8 stdin")?
        } else {
            fs::read_to_string(path).map_err(|_| "Cannot read UTF-8 --file")?
        };
        if values.insert("content".into(), Value::String(content)).is_some() {
            return Err("Use either --content or --file, not both".into());
        }
    }
    if tool == "remote_write" && !values.contains_key("content") {
        return Err("Write content is required. Retry with `--content TEXT` or pipe UTF-8 data to `--file -`".into());
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
    let timeout = config
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(120_000);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global((timeout > 0).then(|| Duration::from_millis(timeout)))
        .build()
        .into();
    let mut response = agent
        .post(url.as_str())
        .header("content-type", "application/json")
        .send_json(json!({ "name": name, "arguments": arguments }))
        .map_err(|_| "Local SAFS router request failed or timed out")?;
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
    if let Some(command) = requested_help(&args) {
        print!("{}", command.and_then(command_help).unwrap_or(HELP));
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
    let reads_stdin = args.windows(2).any(|pair| {
        matches!(pair, [flag, value] if (flag == "--input" || flag == "--file") && value == "-")
    });
    let stdin_content = if reads_stdin {
        let mut value = String::new();
        io::stdin()
            .read_to_string(&mut value)
            .map_err(|_| "Cannot read UTF-8 stdin")?;
        Some(value)
    } else {
        None
    };
    let (name, arguments) = request_with_context(
        args,
        env::current_dir()
            .map_err(|_| "Cannot determine current directory")?
            .to_string_lossy()
            .into(),
        stdin_content,
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
    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn routes_global_and_command_help_without_intercepting_remote_arguments() {
        assert_eq!(requested_help(&strings(&["-h"])), Some(None));
        assert_eq!(
            requested_help(&strings(&["edit", "--help"])),
            Some(Some("edit"))
        );
        assert_eq!(
            requested_help(&strings(&["--config", "file", "upload", "-h"])),
            Some(Some("upload"))
        );
        assert_eq!(requested_help(&strings(&["exec", "--", "--help"])), None);
        assert_eq!(
            requested_help(&strings(&["exec", "--command", "--help"])),
            None
        );
        assert_eq!(
            requested_help(&strings(&["write", "--content", "-h"])),
            None
        );
        for command in [
            "bind",
            "workspaces",
            "switch",
            "current-file",
            "list",
            "read",
            "read-many",
            "search",
            "find",
            "edit",
            "write",
            "delete",
            "chmod",
            "move",
            "upload",
            "download",
            "exec",
            "output",
            "batch",
        ] {
            assert!(command_help(command).unwrap().starts_with("Usage: safs "));
        }
    }

    #[test]
    fn maps_every_cli_command_to_its_router_operation() {
        let cases: &[(&[&str], &str)] = &[
            (&["bind"], "safs_get_remote_workspace"),
            (&["workspaces"], "cli_list_workspaces"),
            (
                &["switch", "--workspace", "w", "--confirmed"],
                "safs_switch_remote_workspace",
            ),
            (&["current-file", "--binding", "b"], "current_remote_file"),
            (&["list", "--binding", "b"], "remote_list"),
            (&["read", "--binding", "b"], "remote_read"),
            (
                &["read-many", "--binding", "b", "--input", "{}"],
                "remote_read_many",
            ),
            (
                &["search", "--binding", "b", "--query", "TODO"],
                "remote_search",
            ),
            (
                &["find", "--binding", "b", "--name", "*.ts"],
                "remote_search",
            ),
            (&["edit", "--binding", "b", "--input", "{}"], "remote_edit"),
            (
                &[
                    "write",
                    "--binding",
                    "b",
                    "--input",
                    r#"{"content":"x"}"#,
                ],
                "remote_write",
            ),
            (&["delete", "--binding", "b"], "remote_delete"),
            (&["chmod", "--binding", "b"], "remote_chmod"),
            (&["move", "--binding", "b", "--input", "{}"], "remote_move"),
            (
                &["upload", "--binding", "b", "--input", "{}"],
                "remote_upload",
            ),
            (
                &["download", "--binding", "b", "--input", "{}"],
                "remote_download",
            ),
            (
                &[
                    "output",
                    "--binding",
                    "b",
                    "--id",
                    "o",
                    "--stream",
                    "stdout",
                ],
                "remote_output",
            ),
            (
                &["exec", "--binding", "b", "--", "pwd"],
                "run_remote_command",
            ),
        ];
        for (arguments, expected) in cases {
            let (actual, _) = request(strings(arguments), "/cwd".into()).unwrap();
            assert_eq!(&actual, expected, "arguments: {arguments:?}");
        }
    }

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
    fn accepts_common_command_write_and_filename_aliases() {
        let (_, command) = request(
            strings(&["exec", "--binding", "id", "--command", "pwd"]),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(command["command"], "pwd");

        let (_, write) = request(
            strings(&[
                "write",
                "--binding",
                "id",
                "--path",
                "note.txt",
                "--content",
                "hello",
            ]),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(write["content"], "hello");

        for arguments in [
            strings(&["search", "--binding", "id", "--name", "*.ts"]),
            strings(&["find", "--binding", "id", "--name", "*.ts"]),
        ] {
            let (name, search) = request(arguments, "/cwd".into()).unwrap();
            assert_eq!(name, "remote_search");
            assert_eq!(search["query"], "*.ts");
            assert_eq!(search["mode"], "names");
        }
    }

    #[test]
    fn alias_conflicts_return_actionable_usage() {
        let command = request(
            strings(&[
                "exec",
                "--binding",
                "id",
                "--command",
                "pwd",
                "--",
                "whoami",
            ]),
            "/cwd".into(),
        )
        .unwrap_err();
        assert!(command.contains("Use either --command or --, not both"));
        assert!(command.contains("Usage: safs exec"));

        let search = request(
            strings(&[
                "search",
                "--binding",
                "id",
                "--query",
                "TODO",
                "--name",
                "*.ts",
            ]),
            "/cwd".into(),
        )
        .unwrap_err();
        assert!(search.contains("Use either --query or --name, not both"));
        assert!(search.contains("files returns paths of files whose CONTENT matches"));
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
        assert!(request(
            strings(&["switch", "--workspace", "id", "--confirmed", "false"]),
            "/cwd".into()
        )
        .is_err());
        assert!(request(
            strings(&["switch", "--workspace", "id", "--confirmed", "true"]),
            "/cwd".into()
        )
        .is_ok());
    }
    #[test]
    fn missing_binding_includes_actionable_command_help() {
        let error = request(strings(&["current-file"]), "/cwd".into()).unwrap_err();
        assert!(error.contains("--binding is required"));
        assert!(error.contains("bindingId returned by `safs bind` or `safs switch`"));
        assert!(error.contains("Usage: safs current-file --binding ID"));
    }
    #[test]
    fn reads_structured_input_and_write_content_from_stdin() {
        let (_, edit) = request_with_context(
            strings(&["edit", "--binding", "id", "--path", "a", "--input", "-"]),
            "/cwd".into(),
            Some(r#"{"edits":[{"oldText":"a","newText":"b"}]}"#.into()),
        )
        .unwrap();
        assert_eq!(edit["edits"][0]["newText"], "b");

        let (_, write) = request_with_context(
            strings(&["write", "--binding", "id", "--path", "a", "--file", "-"]),
            "/cwd".into(),
            Some("replacement\n".into()),
        )
        .unwrap();
        assert_eq!(write["content"], "replacement\n");
    }
    #[test]
    fn syntax_errors_include_only_the_relevant_command_usage() {
        let switch = request(strings(&["switch"]), "/cwd".into()).unwrap_err();
        assert!(switch.contains("--workspace is required"));
        assert!(switch.contains("Usage: safs switch"));
        assert!(!switch.contains("Usage: safs read "));

        let read = request(
            strings(&["read", "--binding", "id", "--input", "not-json"]),
            "/cwd".into(),
        )
        .unwrap_err();
        assert!(read.contains("Invalid --input JSON"));
        assert!(read.contains("Usage: safs read "));
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

    #[test]
    fn maps_current_file_for_direct_and_batch_calls() {
        let (name, args) = request(
            vec!["current-file", "--binding", "id"]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(name, "current_remote_file");
        assert_eq!(args["bindingId"], "id");

        let input = r#"{"operations":[{"command":"current-file"}]}"#;
        let (_, args) = request(
            vec!["batch", "--binding", "id", "--input", input]
                .into_iter()
                .map(String::from)
                .collect(),
            "/cwd".into(),
        )
        .unwrap();
        assert_eq!(args["operations"][0]["name"], "current_remote_file");
        assert_eq!(args["operations"][0]["arguments"]["bindingId"], "id");
    }
}
