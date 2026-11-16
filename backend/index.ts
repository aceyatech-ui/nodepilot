import { router, json, error, requireAuth, db, secrets } from '@appdeploy/sdk';
import { validateWorkflow, executeWorkflow } from './workflow-engine';
import { generateWorkflowWithGemini } from './gemini';

function tableFor(prefix: string, userId: string) {
  const safeId = userId.replace(/[^a-zA-Z0-9]/g, '');
  return `${prefix}_${safeId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bodyObject(body: unknown) {
  return isRecord(body) ? body : null;
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : 'Unexpected server error.';
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ ok: true, app: 'NodePilot' })],

  'GET /api/workflows': [
    requireAuth(),
    async ctx => {
      const table = tableFor('workflows', ctx.user!.userId);
      const result = await db.list(table, { limit: 50 });
      const workflows = result.items.map(item => ({
        id: item.id,
        name: item.name,
        workflow: item.workflow,
        updatedAt: item.updatedAt,
      }));
      return json({ workflows });
    },
  ],

  'POST /api/workflows': [
    requireAuth(),
    async ctx => {
      const body = bodyObject(ctx.body);
      if (!body || typeof body.name !== 'string' || !isRecord(body.workflow))
        return error(
          'A workflow name and workflow document are required.',
          400
        );
      const checked = validateWorkflow(body.workflow);
      if (checked.ok === false) return error(checked.message, 400);
      const name = body.name.trim().slice(0, 100) || 'Untitled workflow';
      const table = tableFor('workflows', ctx.user!.userId);
      const [id] = await db.add(table, [
        {
          name,
          workflow: checked.workflow,
          updatedAt: new Date().toISOString(),
        },
      ]);
      if (!id) return error('Could not save workflow.', 500);
      return json({ id, name });
    },
  ],

  'PUT /api/workflows/:id': [
    requireAuth(),
    async ctx => {
      const body = bodyObject(ctx.body);
      if (!body || typeof body.name !== 'string' || !isRecord(body.workflow))
        return error(
          'A workflow name and workflow document are required.',
          400
        );
      const checked = validateWorkflow(body.workflow);
      if (checked.ok === false) return error(checked.message, 400);
      const table = tableFor('workflows', ctx.user!.userId);
      const [existing] = await db.get<{
        name: string;
        workflow: unknown;
        updatedAt: string;
      }>(table, [ctx.params.id]);
      if (!existing) return error('Workflow not found.', 404);
      const updated = await db.update(table, [
        {
          id: ctx.params.id,
          record: {
            name: body.name.trim().slice(0, 100) || 'Untitled workflow',
            workflow: checked.workflow,
            updatedAt: new Date().toISOString(),
          },
        },
      ]);
      if (!updated[0]) return error('Workflow update failed.', 500);
      return json({ id: ctx.params.id, ok: true });
    },
  ],

  'DELETE /api/workflows/:id': [
    requireAuth(),
    async ctx => {
      const table = tableFor('workflows', ctx.user!.userId);
      const [existing] = await db.get(table, [ctx.params.id]);
      if (!existing) return error('Workflow not found.', 404);
      const deleted = await db.delete(table, [ctx.params.id]);
      if (!deleted[0]) return error('Workflow deletion failed.', 500);
      return json({ ok: true });
    },
  ],

  'POST /api/workflows/:id/run': [
    requireAuth(),
    async ctx => {
      const table = tableFor('workflows', ctx.user!.userId);
      const [saved] = await db.get<{ name: string; workflow: unknown }>(table, [
        ctx.params.id,
      ]);
      if (!saved || !isRecord(saved.workflow))
        return error('Workflow not found.', 404);
      const checked = validateWorkflow(saved.workflow);
      if (checked.ok === false) return error(checked.message, 400);
      try {
        const execution = await executeWorkflow(
          checked.workflow,
          async (prompt, input) => {
            const names = await secrets.listSecretNames();
            if (!names.includes('GEMINI_API_KEY'))
              throw new Error(
                'Gemini is not configured. Add GEMINI_API_KEY in your secure app settings.'
              );
            const key = await secrets.readSecret('GEMINI_API_KEY');
            return generateWorkflowWithGemini(key, prompt, input, false);
          }
        );
        const runTable = tableFor('runs', ctx.user!.userId);
        const [runId] = await db.add(runTable, [
          {
            workflowName: saved.name,
            workflowId: ctx.params.id,
            status: 'completed',
            createdAt: new Date().toISOString(),
            output: execution,
          },
        ]);
        return json({ execution: { ...execution, runId: runId ?? null } });
      } catch (err: unknown) {
        return error(messageOf(err).slice(0, 300), 400);
      }
    },
  ],

  'GET /api/runs': [
    requireAuth(),
    async ctx => {
      const result = await db.list(tableFor('runs', ctx.user!.userId), {
        limit: 30,
      });
      const runs = result.items
        .map(item => ({
          id: item.id,
          workflowName: item.workflowName,
          status: item.status,
          createdAt: item.createdAt,
          output: item.output,
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json({ runs });
    },
  ],

  'POST /api/assistant/workflow': [
    requireAuth(),
    async ctx => {
      const body = bodyObject(ctx.body);
      if (!body || typeof body.prompt !== 'string' || !body.prompt.trim())
        return error('Describe the workflow you want Gemini to build.', 400);
      if (body.prompt.length > 3000)
        return error(
          'Prompt is too long. Keep it under 3,000 characters.',
          400
        );
      const names = await secrets.listSecretNames();
      if (!names.includes('GEMINI_API_KEY'))
        return error(
          'Gemini is not configured. Add GEMINI_API_KEY in your secure app settings.',
          503
        );
      try {
        const key = await secrets.readSecret('GEMINI_API_KEY');
        const result = await generateWorkflowWithGemini(
          key,
          body.prompt,
          body.currentWorkflow,
          true
        );
        const checked = validateWorkflow(result);
        if (checked.ok === false)
          return error(
            'Gemini returned a workflow that failed validation. Try a more specific prompt.',
            502
          );
        return json({ workflow: checked.workflow });
      } catch (err: unknown) {
        return error(messageOf(err).slice(0, 300), 502);
      }
    },
  ],
});
