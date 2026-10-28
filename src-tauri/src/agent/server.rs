//! MCP stdio server.
//!
//! Library: `rmcp` 3.8 (the official Rust MCP SDK), default features off, `server` + `transport-io`. It builds
//! against the tokio Tauri already pulls in and adds 5 crates (rmcp, pastey, schemars_derive, serde_derive_internals,
//! tokio-macros), so it beats keeping a hand-written JSON-RPC loop in step with the spec.
//! stdout carries protocol messages only; diagnostics go to stderr.
use super::tools::TOOL_SPECS;
use rmcp::model::{CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};

/// velo's version (tauri.conf.json, kept in step with package.json), not the crate's.
static APP_VERSION: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap_or_default();
    conf["version"].as_str().unwrap_or(env!("CARGO_PKG_VERSION")).to_string()
});

type Dispatch = dyn Fn(&str, serde_json::Value) -> Result<serde_json::Value, String> + Send + Sync;

struct Velo(std::sync::Arc<Dispatch>);

impl ServerHandler for Velo {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(Implementation::new("velo", APP_VERSION.as_str()))
    }

    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        let tools = TOOL_SPECS
            .iter()
            .map(|t| {
                let schema = serde_json::from_str(t.input_schema).map_err(|e| ErrorData::internal_error(format!("bad schema for {}: {e}", t.name), None))?;
                Ok(Tool::new(t.name, t.description, std::sync::Arc::new(schema)))
            })
            .collect::<Result<_, ErrorData>>()?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(&self, req: CallToolRequestParams, _: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let args = req.arguments.map(serde_json::Value::Object).unwrap_or_else(|| serde_json::json!({}));
        // off the runtime: a blocking call (up to ~90 s when forwarded) would stall pings and cancellations
        let d = self.0.clone();
        let r = tokio::task::spawn_blocking(move || d(&req.name, args)).await.map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(match r {
            Ok(v) => CallToolResult::success(vec![ContentBlock::text(v.to_string())]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e)]),
        }
        .into())
    }
}

/// Serves MCP over stdin/stdout until the client closes stdin. Each `tools/call` goes to `dispatch`; an `Err` comes
/// back as a tool result with `isError: true`.
pub fn run_stdio(dispatch: impl Fn(&str, serde_json::Value) -> Result<serde_json::Value, String> + Send + Sync + 'static) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(async {
        let service = Velo(std::sync::Arc::new(dispatch)).serve(rmcp::transport::stdio()).await?;
        service.waiting().await?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use rmcp::ServiceExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// A ping sent while a tool call is still running is answered first: the call must not block the runtime.
    #[test] fn ping_is_answered_during_a_slow_call() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (client, server) = tokio::io::duplex(1 << 16);
            let (sr, sw) = tokio::io::split(server);
            let slow = |_: &str, _: serde_json::Value| {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                Ok(serde_json::json!("done"))
            };
            tokio::spawn(async move { super::Velo(std::sync::Arc::new(slow)).serve((sr, sw)).await.unwrap().waiting().await.ok() });
            let (cr, mut cw) = tokio::io::split(client);
            let mut lines = BufReader::new(cr).lines();
            for m in [
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tags","arguments":{}}}"#,
                r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#,
            ] {
                cw.write_all(format!("{m}\n").as_bytes()).await.unwrap();
            }
            let mut ids = vec![];
            while ids.len() < 3 {
                let l = lines.next_line().await.unwrap().unwrap();
                ids.push(serde_json::from_str::<serde_json::Value>(&l).unwrap()["id"].as_u64().unwrap());
            }
            assert_eq!(ids, [1, 3, 2]);
        });
    }

    #[test] fn server_version_is_the_app_version() {
        let pkg: serde_json::Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
        assert_eq!(super::APP_VERSION.as_str(), pkg["version"].as_str().unwrap());
    }
}
