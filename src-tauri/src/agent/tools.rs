//! The MCP tools velo exposes. Filled in by Task 2.

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema (an object) as text
    pub input_schema: &'static str,
}

pub const TOOL_SPECS: &[ToolSpec] = &[];

pub fn call(_name: &str, _args: serde_json::Value) -> Result<serde_json::Value, String> {
    Err("unknown tool".into())
}
