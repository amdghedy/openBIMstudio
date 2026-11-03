# AI-native modeling

## How it works

The AI Assistant uses the configured model only for language understanding and planning. It does not automate the DeepSeek website or read a user's DeepSeek browser session.

The assistant sends approved function/tool definitions to the configured provider. When the model requests a tool, the application validates the arguments and invokes its own native authoring APIs. Geometry is therefore created by openBIMstudio, not drawn by the model as an image or simulated in the chat transcript.

## Native linear authoring

The `create_linear_elements` tool creates straight authored elements through `src/features/authoring.ts:addLinearElement`. This is the same authoring path used by the plan-view drawing workflow, preserving the platform's geometry generation and authoring history.

Supported types:

- Architecture: walls
- Structure: beams and strips
- MEP: ducts, pipes, cable trays, conduits
- Other linear authored members: mline

Coordinates are metres in the plan X/Z plane; elevation is the Y/base elevation in metres. Each segment requires explicit `start: [x,z]` and `end: [x,z]`. A batch is limited to 100 segments. Height and thickness may be specified per segment or for the whole request; when omitted, the existing authoring type defaults apply. The tool reports the actual committed element count and IDs where available.

The tool rejects malformed coordinates, unsupported types, zero-length segments, invalid dimensions, and oversized batches before making any model changes. It restores the active level and wall placement-line settings after execution. The assistant must not invent a wall's position or orientation: when the user's instruction does not establish them, it asks for the missing placement information.

The initial tool is intentionally limited to straight linear elements. Hosted doors/windows, slabs, columns, openings, curved elements, and more advanced parametric assemblies require dedicated tools that respect each category's host, constraints, geometry and validation rules; they must not be faked by placing generic boxes.

## Model/provider options and cost

- **DeepSeek Chat website:** `https://chat.deepseek.com/` is a standalone website. A signed-in website session is not an API credential and cannot be safely reused by openBIMstudio as a model endpoint.
- **DeepSeek API:** can be configured through the OpenAI-compatible provider when the user supplies their own API key. API billing and limits are separate from the free website chat.
- **Local Ollama:** can run a locally installed model without per-request API charges. Choose a model that supports reliable function/tool calling; tool support varies by model and version. Local execution still uses the same native tool validation and authoring code.

## Safety and validation

- Read-only inspection tools do not mutate the model.
- Native geometry creation is limited to validated arguments and the active authoring service.
- Delete/clear operations retain their existing explicit user-confirmation flow.
- Tool responses must be checked before the assistant claims that an operation succeeded.
- AI-generated geometry is not a substitute for engineering review, code compliance, or coordination checks.
