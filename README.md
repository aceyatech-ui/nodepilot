# NodePilot

NodePilot is a visual workflow builder for creating, editing, importing, exporting, and running lightweight automations.

## Features

- Visual workflow editor powered by React Flow.
- Workflow nodes for triggers, setting values, conditional branches, Gemini-assisted steps, and logging.
- Workflow saving and run-history views with account-scoped data handling.
- JSON workflow import and export.
- A starter n8n JSON importer for a limited set of compatible node types.
- Gemini integration for AI-assisted workflow steps.

## n8n import compatibility

The importer is intentionally limited. It currently maps common node types such as manual triggers, Set/Edit Fields, If, No Operation, and Google Gemini nodes into NodePilot equivalents. It does not reproduce the full n8n runtime.

In particular, n8n expressions, credentials, complex connection semantics, arbitrary node types, and all execution behaviours are not guaranteed to import. Unsupported nodes may cause the import to be rejected rather than silently producing a misleading workflow. Review imported workflows before running them.

## Gemini configuration

The deployed AppDeploy application uses the `GEMINI_API_KEY` secret configured in its secure app settings. Never commit API keys or other secrets to this repository. The key is an application-level secret, not a per-user credential vault.

## Development

This source was built for the AppDeploy runtime and uses AppDeploy-provided integration/runtime capabilities. It may require adaptation before running on a generic hosting provider.

Typical frontend commands, where the required runtime integrations are available:

```bash
npm install
npm run dev
npm run build
```

## Project structure

- `src/App.tsx` - main workflow studio UI.
- `src/index.css` - application styling.
- `src/main.tsx` - frontend entry point.
- `backend/` - backend workflow execution, realtime support, and Gemini integration.
- `tests/tests.json` - project test definitions.

## Security notes

- Keep secrets in the hosting provider's secure environment configuration.
- Do not place API keys in frontend code, exported workflows, screenshots, or committed files.
- Treat imported workflow JSON as untrusted input and inspect it before execution.

## Status

This is an actively developed project. The n8n importer is a compatibility starter, not a full n8n migration tool.
