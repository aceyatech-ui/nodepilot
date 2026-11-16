export type WorkflowNode = {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data: { label?: string; kind: string; config?: Record<string, unknown> };
};
export type WorkflowEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};
export type WorkflowDoc = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const allowedKinds = new Set(['trigger', 'set', 'if', 'gemini', 'log']);

export function validateWorkflow(
  value: unknown
): { ok: true; workflow: WorkflowDoc } | { ok: false; message: string } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    return {
      ok: false,
      message: 'Workflow must contain nodes and edges arrays.',
    };
  if (value.nodes.length < 1 || value.nodes.length > 40)
    return {
      ok: false,
      message: 'A workflow must have between 1 and 40 nodes.',
    };
  if (value.edges.length > 100)
    return {
      ok: false,
      message: 'A workflow can have at most 100 connections.',
    };
  const ids = new Set<string>();
  for (const raw of value.nodes) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      !isRecord(raw.data) ||
      typeof raw.data.kind !== 'string'
    )
      return { ok: false, message: 'A node is missing its ID or type.' };
    if (ids.has(raw.id))
      return { ok: false, message: 'Node IDs must be unique.' };
    ids.add(raw.id);
    if (!allowedKinds.has(raw.data.kind))
      return { ok: false, message: `Unsupported node type: ${raw.data.kind}.` };
    if (raw.data.config !== undefined && !isRecord(raw.data.config))
      return {
        ok: false,
        message: 'Node configuration must be a JSON object.',
      };
  }
  for (const raw of value.edges) {
    if (
      !isRecord(raw) ||
      typeof raw.source !== 'string' ||
      typeof raw.target !== 'string' ||
      !ids.has(raw.source) ||
      !ids.has(raw.target)
    )
      return { ok: false, message: 'A connection points to an invalid node.' };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > 220_000)
    return {
      ok: false,
      message: 'Workflow JSON is too large. Maximum size is 220 KB.',
    };
  return { ok: true, workflow: value as unknown as WorkflowDoc };
}

function readPath(input: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) => (isRecord(value) ? value[key] : undefined),
      input
    );
}

export async function executeWorkflow(
  workflow: WorkflowDoc,
  askGemini: (prompt: string, input: unknown) => Promise<string>
) {
  const byId = new Map(workflow.nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  const trigger = workflow.nodes.find(node => node.data.kind === 'trigger');
  if (!trigger)
    throw new Error('Add a Manual Trigger node before running this workflow.');
  const queue = [trigger.id];
  const visited = new Set<string>();
  const logs: Array<{ nodeId: string; node: string; result: unknown }> = [];
  let context: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
  };
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    if (visited.size >= 100) throw new Error('Execution step limit reached.');
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    const config = node.data.config ?? {};
    let result: unknown = context;
    let selectedHandle: string | null = null;
    switch (node.data.kind) {
      case 'trigger':
        result = context;
        break;
      case 'set': {
        const fields = isRecord(config.fields) ? config.fields : {};
        context = { ...context, ...fields };
        result = context;
        break;
      }
      case 'if': {
        const path = typeof config.path === 'string' ? config.path : '';
        const actual = readPath(context, path);
        const expected = config.value;
        const operator =
          typeof config.operator === 'string' ? config.operator : 'equals';
        let passed = false;
        if (operator === 'equals') passed = actual === expected;
        else if (operator === 'not_equals') passed = actual !== expected;
        else if (operator === 'contains')
          passed =
            typeof actual === 'string' &&
            typeof expected === 'string' &&
            actual.includes(expected);
        else if (operator === 'is_set')
          passed = actual !== undefined && actual !== null && actual !== '';
        else throw new Error(`Unsupported condition operator: ${operator}`);
        selectedHandle = passed ? 'true' : 'false';
        result = { passed, actual, expected, operator };
        break;
      }
      case 'gemini': {
        const prompt =
          typeof config.prompt === 'string'
            ? config.prompt.slice(0, 1500)
            : 'Summarize the input.';
        const answer = await askGemini(prompt, context);
        context = { ...context, gemini: answer };
        result = { answer };
        break;
      }
      case 'log':
        result = context;
        break;
      default:
        throw new Error('Unsupported node encountered during execution.');
    }
    logs.push({ nodeId: id, node: node.data.label ?? node.data.kind, result });
    const next = outgoing.get(id) ?? [];
    for (const edge of next) {
      if (node.data.kind === 'if') {
        if ((edge.sourceHandle ?? 'true') === selectedHandle)
          queue.push(edge.target);
      } else {
        queue.push(edge.target);
      }
    }
  }
  return {
    status: 'completed',
    steps: visited.size,
    finishedAt: new Date().toISOString(),
    context,
    logs,
  };
}
