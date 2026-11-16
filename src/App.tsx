import { useCallback, useEffect, useMemo, useState } from 'react';
import { auth, api } from '@appdeploy/client';
import {
  ReactFlow,
  addEdge,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  Cloud,
  Download,
  FileJson,
  GitBranch,
  KeyRound,
  LogOut,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';

type FlowNode = Node<{
  label: string;
  kind: string;
  config: Record<string, unknown>;
}>;
type FlowEdge = Edge;
type WorkflowDoc = { nodes: FlowNode[]; edges: FlowEdge[] };
type SavedWorkflow = {
  id: string;
  name: string;
  workflow: WorkflowDoc;
  updatedAt: string;
};

const starter: WorkflowDoc = {
  nodes: [
    {
      id: 'trigger-1',
      type: 'input',
      position: { x: 100, y: 150 },
      data: { label: 'Manual Trigger', kind: 'trigger', config: {} },
    },
    {
      id: 'set-1',
      position: { x: 390, y: 150 },
      data: {
        label: 'Set Values',
        kind: 'set',
        config: {
          fields: { message: 'Hello from NodePilot', priority: 'normal' },
        },
      },
    },
    {
      id: 'log-1',
      type: 'output',
      position: { x: 690, y: 150 },
      data: { label: 'Output', kind: 'log', config: {} },
    },
  ],
  edges: [
    {
      id: 'e-trigger-set',
      source: 'trigger-1',
      target: 'set-1',
      animated: true,
    },
    { id: 'e-set-log', source: 'set-1', target: 'log-1', animated: true },
  ],
};

const nodeCatalog = [
  {
    kind: 'trigger',
    label: 'Manual Trigger',
    icon: Play,
    hint: 'Starts a workflow run',
  },
  {
    kind: 'set',
    label: 'Set Values',
    icon: Braces,
    hint: 'Add or change data fields',
  },
  {
    kind: 'if',
    label: 'Condition',
    icon: GitBranch,
    hint: 'Route true or false',
  },
  {
    kind: 'gemini',
    label: 'Gemini AI',
    icon: Sparkles,
    hint: 'Generate text with Gemini',
  },
  { kind: 'log', label: 'Output', icon: Activity, hint: 'Inspect the result' },
];

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function convertN8nExport(parsed: Record<string, unknown>, fallbackName: string) {
  if (!Array.isArray(parsed.nodes) || !parsed.connections || typeof parsed.connections !== 'object') {
    throw new Error('Not a recognised n8n export. Expected a nodes array and connections object.');
  }
  const rawNodes = parsed.nodes as Array<Record<string, unknown>>;
  if (!rawNodes.length || rawNodes.length > 40) throw new Error('Import supports 1 to 40 nodes.');
  const typeMap: Record<string, string> = {
    'n8n-nodes-base.manualTrigger': 'trigger',
    'n8n-nodes-base.start': 'trigger',
    'n8n-nodes-base.set': 'set',
    'n8n-nodes-base.editFields': 'set',
    'n8n-nodes-base.if': 'if',
    'n8n-nodes-base.noOp': 'log',
    'n8n-nodes-base.googleGemini': 'gemini',
    '@n8n/n8n-nodes-langchain.googleGemini': 'gemini',
  };
  const unsupported: string[] = [];
  const ids = new Map<string, string>();
  const nodes = rawNodes.map((raw, index) => {
    const nodeType = typeof raw.type === 'string' ? raw.type : '';
    const kind = typeMap[nodeType];
    const name = typeof raw.name === 'string' ? raw.name : `Node ${index + 1}`;
    if (!kind) unsupported.push(`${name} (${nodeType || 'unknown'})`);
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `n8n-${index + 1}-${crypto.randomUUID().slice(0, 6)}`;
    ids.set(name, id);
    const params = raw.parameters && typeof raw.parameters === 'object' ? raw.parameters as Record<string, unknown> : {};
    let config: Record<string, unknown> = {};
    if (kind === 'set') {
      const fields: Record<string, unknown> = {};
      const assignments = (params.assignments as { assignments?: Array<Record<string, unknown>> } | undefined)?.assignments;
      if (Array.isArray(assignments)) assignments.forEach(item => {
        if (typeof item.name === 'string') fields[item.name] = item.value;
      });
      const values = params.values as Record<string, unknown> | undefined;
      if (values) Object.values(values).forEach(group => {
        if (Array.isArray(group)) (group as Array<Record<string, unknown>>).forEach(item => {
          if (typeof item.name === 'string') fields[item.name] = item.value;
        });
      });
      config = { fields };
    }
    if (kind === 'if') {
      const conditions = params.conditions as { conditions?: Array<Record<string, unknown>> } | undefined;
      const first = conditions?.conditions?.[0] ?? {};
      const left = typeof first.leftValue === 'string' ? first.leftValue : '';
      const match = left.match(/\$json\.([\w.]+)/);
      const operator = (first.operator as Record<string, unknown> | undefined)?.operation;
      config = {
        path: match?.[1] ?? left.replace(/^\$json\.?/, ''),
        operator: operator === 'notEquals' ? 'not_equals' : operator === 'contains' ? 'contains' : 'equals',
        value: first.rightValue ?? '',
      };
    }
    if (kind === 'gemini') config = { prompt: 'Summarise the incoming data in one sentence.' };
    const pos = Array.isArray(raw.position) ? raw.position as number[] : [];
    return {
      id,
      type: kind === 'trigger' ? 'input' : kind === 'log' ? 'output' : 'default',
      position: { x: Number(pos[0]) || 100 + (index % 3) * 250, y: Number(pos[1]) || 100 + Math.floor(index / 3) * 150 },
      data: { label: name, kind: kind ?? 'unsupported', config },
    } as FlowNode;
  });
  if (unsupported.length) {
    throw new Error(`Unsupported n8n nodes: ${unsupported.join(', ')}. Nothing was imported. Replace these nodes in n8n and export again.`);
  }
  const edges: FlowEdge[] = [];
  const connections = parsed.connections as Record<string, { main?: Array<Array<Record<string, unknown>>> }>;
  Object.entries(connections).forEach(([sourceName, groups]) => {
    const source = ids.get(sourceName);
    (groups.main ?? []).forEach((targets, outputIndex) => targets.forEach(target => {
      const destination = ids.get(String(target.node ?? ''));
      if (!source || !destination) throw new Error('An n8n connection references a missing node.');
      const sourceNode = rawNodes.find(node => node.name === sourceName);
      edges.push({
        id: `edge-${edges.length}-${source}-${destination}`,
        source,
        target: destination,
        ...(sourceNode?.type === 'n8n-nodes-base.if' ? { sourceHandle: outputIndex === 0 ? 'true' : 'false' } : {}),
      });
    }));
  });
  if (edges.length > 100) throw new Error('Import supports up to 100 connections.');
  return { name: typeof parsed.name === 'string' ? parsed.name : fallbackName, nodes, edges };
}

function App() {
  const [user, setUser] = useState<{
    userId: string;
    email?: string;
    name?: string;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [runs, setRuns] = useState<
    Array<{
      id: string;
      workflowName: string;
      status: string;
      createdAt: string;
      output?: unknown;
    }>
  >([]);
  const [workflowName, setWorkflowName] = useState('My first workflow');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    starter.nodes
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    starter.edges
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configText, setConfigText] = useState('{}');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [runOutput, setRunOutput] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<'editor' | 'runs'>('editor');

  const selectedNode = useMemo(
    () =>
      nodes.find(node => node.id === selectedNodeId) as FlowNode | undefined,
    [nodes, selectedNodeId]
  );

  const refreshData = useCallback(async () => {
    const [workflowResponse, runResponse] = await Promise.all([
      api.get('/api/workflows'),
      api.get('/api/runs'),
    ]);
    setWorkflows(workflowResponse.data.workflows ?? []);
    setRuns(runResponse.data.runs ?? []);
  }, []);

  useEffect(() => {
    let alive = true;
    auth
      .getUser()
      .then(current => {
        if (alive) setUser(current);
      })
      .catch((err: unknown) => {
        if (alive)
          setAuthError(
            err instanceof Error
              ? err.message
              : 'Could not restore your session.'
          );
      })
      .finally(() => {
        if (alive) setAuthLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshData().catch((err: unknown) =>
      setNotice(
        err instanceof Error ? err.message : 'Could not load your workspace.'
      )
    );
  }, [user, refreshData]);

  useEffect(() => {
    if (!selectedNode) return;
    setConfigText(pretty(selectedNode.data.config ?? {}));
  }, [selectedNodeId, selectedNode]);

  const signIn = async () => {
    setAuthError('');
    try {
      await auth.signInWithRedirect();
    } catch (err: unknown) {
      setAuthError(
        err instanceof Error ? err.message : 'Sign-in failed. Please retry.'
      );
    }
  };

  const addNode = (kind: string, label: string) => {
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const config =
      kind === 'set'
        ? { fields: { example: 'value' } }
        : kind === 'if'
          ? { path: 'priority', operator: 'equals', value: 'high' }
          : kind === 'gemini'
            ? { prompt: 'Summarize the incoming data in one sentence.' }
            : {};
    const node: FlowNode = {
      id,
      position: { x: 170 + (nodes.length % 3) * 80, y: 90 + nodes.length * 45 },
      data: { label, kind, config },
    };
    setNodes(current => [...current, node]);
    setSelectedNodeId(id);
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(current => addEdge({ ...connection, animated: true }, current));
    },
    [setEdges]
  );

  const saveWorkflow = async () => {
    setBusy('save');
    setNotice('');
    try {
      const workflow = { nodes, edges };
      const payload = {
        name: workflowName.trim() || 'Untitled workflow',
        workflow,
      };
      const response = workflowId
        ? await api.put(`/api/workflows/${workflowId}`, payload)
        : await api.post('/api/workflows', payload);
      setWorkflowId(response.data.id);
      await refreshData();
      setNotice('Workflow saved securely.');
    } catch (err: unknown) {
      setNotice(
        err instanceof Error ? err.message : 'Could not save workflow.'
      );
    } finally {
      setBusy('');
    }
  };

  const openWorkflow = (item: SavedWorkflow) => {
    setWorkflowId(item.id);
    setWorkflowName(item.name);
    setNodes(item.workflow.nodes);
    setEdges(item.workflow.edges);
    setSelectedNodeId(null);
    setRunOutput(null);
    setActiveTab('editor');
  };

  const newWorkflow = () => {
    setWorkflowId(null);
    setWorkflowName('Untitled workflow');
    setNodes(starter.nodes);
    setEdges(starter.edges);
    setSelectedNodeId(null);
    setRunOutput(null);
    setActiveTab('editor');
  };

  const exportWorkflow = () => {
    const workflowExport = {
      name: workflowName,
      nodes,
      edges,
      meta: { exportedBy: 'NodePilot', formatVersion: 1 },
    };
    const blob = new Blob([pretty(workflowExport)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${workflowName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'workflow'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('Workflow JSON exported.');
  };

  const importWorkflow = async (file?: File) => {
    if (!file) return;
    setBusy('import');
    try {
      if (file.size > 250_000) throw new Error('JSON file is too large. Maximum size is 250 KB.');
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      let normalizedNodes: FlowNode[];
      let normalizedEdges: FlowEdge[];
      let importedName = file.name.replace(/\.json$/i, '');
      const isNodePilot = Array.isArray(parsed.nodes) && parsed.nodes.every((node: unknown) =>
        Boolean(node && typeof node === 'object' && (node as Record<string, unknown>).data &&
          typeof ((node as Record<string, unknown>).data as Record<string, unknown>).kind === 'string')
      );
      if (isNodePilot) {
        const rawNodes = parsed.nodes as Array<Record<string, unknown>>;
        if (!Array.isArray(parsed.edges)) throw new Error('NodePilot JSON must include nodes and edges.');
        const allowed = new Set(nodeCatalog.map(item => item.kind));
        normalizedNodes = rawNodes.map((item, index) => {
          const data = item.data as Record<string, unknown>;
          const kind = String(data.kind);
          if (!allowed.has(kind)) throw new Error(`Unsupported node type "${kind}" at position ${index + 1}.`);
          return {
            ...item,
            type: kind === 'trigger' ? 'input' : kind === 'log' ? 'output' : 'default',
            data: { ...data, label: typeof data.label === 'string' ? data.label : kind,
              config: data.config && typeof data.config === 'object' ? data.config : {} },
          } as FlowNode;
        });
        normalizedEdges = (parsed.edges as Array<Record<string, unknown>>).map(edge => {
          if (typeof edge.source !== 'string' || typeof edge.target !== 'string') throw new Error('Invalid connection in JSON.');
          return { ...edge, id: typeof edge.id === 'string' ? edge.id : crypto.randomUUID() } as FlowEdge;
        });
        importedName = typeof parsed.name === 'string' ? parsed.name : importedName;
      } else {
        const converted = convertN8nExport(parsed, importedName);
        normalizedNodes = converted.nodes;
        normalizedEdges = converted.edges;
        importedName = converted.name;
      }
      if (!normalizedNodes.length || normalizedNodes.length > 40 || normalizedEdges.length > 100)
        throw new Error('Import supports 1 to 40 nodes and up to 100 connections.');
      const ids = new Set(normalizedNodes.map(node => node.id));
      if (normalizedEdges.some(edge => !ids.has(edge.source) || !ids.has(edge.target)))
        throw new Error('A connection points to a node that does not exist.');
      setNodes(normalizedNodes);
      setEdges(normalizedEdges);
      setWorkflowName(importedName);
      setWorkflowId(null);
      setSelectedNodeId(null);
      setNotice('Workflow imported. Review its nodes and connections, then save.');
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : 'Could not import workflow JSON.');
    } finally {
      setBusy('');
    }
  };

  const runWorkflow = async () => {
    setBusy('run');
    setNotice('');
    try {
      let id = workflowId;
      if (!id) {
        const saved = await api.post('/api/workflows', {
          name: workflowName,
          workflow: { nodes, edges },
        });
        id = saved.data.id;
        setWorkflowId(id);
      } else {
        await api.put(`/api/workflows/${id}`, {
          name: workflowName,
          workflow: { nodes, edges },
        });
      }
      const response = await api.post(`/api/workflows/${id}/run`, {});
      setRunOutput(response.data.execution);
      await refreshData();
      setActiveTab('runs');
      setNotice('Workflow execution completed.');
    } catch (err: unknown) {
      setNotice(
        err instanceof Error ? err.message : 'Workflow execution failed.'
      );
    } finally {
      setBusy('');
    }
  };

  const applyNodeConfig = () => {
    try {
      const config = JSON.parse(configText) as Record<string, unknown>;
      if (!config || Array.isArray(config) || typeof config !== 'object')
        throw new Error('Configuration must be a JSON object.');
      setNodes(current =>
        current.map(node =>
          node.id === selectedNodeId
            ? { ...node, data: { ...node.data, config } }
            : node
        )
      );
      setNotice('Node configuration updated.');
    } catch (err: unknown) {
      setNotice(
        err instanceof Error ? err.message : 'Invalid node configuration JSON.'
      );
    }
  };

  const askGemini = async () => {
    if (!assistantPrompt.trim()) return;
    setBusy('assistant');
    setNotice('');
    try {
      const response = await api.post('/api/assistant/workflow', {
        prompt: assistantPrompt.slice(0, 3000),
        currentWorkflow: { nodes, edges },
      });
      const generated = response.data.workflow as WorkflowDoc;
      if (
        !generated ||
        !Array.isArray(generated.nodes) ||
        !Array.isArray(generated.edges)
      )
        throw new Error('Gemini returned an invalid workflow.');
      const allowed = new Set(nodeCatalog.map(item => item.kind));
      if (
        generated.nodes.length > 40 ||
        generated.edges.length > 100 ||
        generated.nodes.some(node => !allowed.has(node.data?.kind))
      ) {
        throw new Error(
          'Gemini suggested unsupported nodes or exceeded the workflow limits.'
        );
      }
      setNodes(generated.nodes);
      setEdges(generated.edges);
      setWorkflowId(null);
      setWorkflowName('Gemini generated workflow');
      setAssistantOpen(false);
      setNotice(
        'Gemini drafted a workflow. Review every node before running it.'
      );
    } catch (err: unknown) {
      setNotice(
        err instanceof Error
          ? err.message
          : 'Gemini could not generate a workflow.'
      );
    } finally {
      setBusy('');
    }
  };

  const deleteWorkflow = async (id: string) => {
    if (!window.confirm('Delete this workflow? This cannot be undone.')) return;
    try {
      await api.delete(`/api/workflows/${id}`);
      if (workflowId === id) newWorkflow();
      await refreshData();
      setNotice('Workflow deleted.');
    } catch (err: unknown) {
      setNotice(
        err instanceof Error ? err.message : 'Could not delete workflow.'
      );
    }
  };

  if (authLoading) {
    return (
      <main className="auth-screen">
        <div className="brand-mark">N</div>
        <p>Restoring your secure workspace…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <div className="brand-mark">N</div>
          <p className="eyebrow">WORKFLOW AUTOMATION, WITHOUT THE CHAOS</p>
          <h1>
            Build systems that <span>do the work.</span>
          </h1>
          <p className="muted">
            Design workflows visually, bring Gemini in as your assistant, and
            keep your credentials private.
          </p>
          {authError && <p className="notice error">{authError}</p>}
          <button className="primary full" onClick={signIn}>
            Sign in to NodePilot <ChevronDown size={16} />
          </button>
          <p className="tiny">
            <KeyRound size={13} /> Your workflows are private to your account.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark small">N</div>
          <div>
            <strong>NodePilot</strong>
            <span>WORKFLOW STUDIO</span>
          </div>
        </div>
        <button className="new-workflow" onClick={newWorkflow}>
          <Plus size={16} /> New workflow
        </button>
        <div className="side-label">YOUR WORKSPACE</div>
        <div className="workflow-list">
          {workflows.map(item => (
            <div
              className={
                item.id === workflowId
                  ? 'workflow-link active'
                  : 'workflow-link'
              }
              key={item.id}
            >
              <button onClick={() => openWorkflow(item)}>
                <WorkflowIcon size={15} />
                <span>{item.name}</span>
              </button>
              <button
                className="icon-button delete-small"
                title="Delete workflow"
                onClick={() => deleteWorkflow(item.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {workflows.length === 0 && (
            <p className="empty-side">Your saved workflows will appear here.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="account">
            <div className="avatar">
              {(user.name || user.email || 'U').slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{user.name || 'Your account'}</strong>
              <span>{user.email || 'Signed in'}</span>
            </div>
          </div>
          <button
            className="quiet-button"
            onClick={() => auth.signOut().then(() => setUser(null))}
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="breadcrumb">
              Workspace <span>/</span>{' '}
              {activeTab === 'runs' ? 'Execution history' : 'Editor'}
            </div>
            {activeTab === 'runs' ? (
              <h1>Execution history</h1>
            ) : (
              <input
                className="workflow-name-input"
                aria-label="Workflow name"
                value={workflowName}
                onChange={event => setWorkflowName(event.target.value)}
                onBlur={() => {
                  if (!workflowName.trim()) setWorkflowName('Untitled workflow');
                }}
                maxLength={100}
              />
            )}
          </div>
          <div className="top-actions">
            <button
              className="secondary"
              onClick={() => setAssistantOpen(true)}
            >
              <Sparkles size={15} /> Ask Gemini
            </button>
            <button className="secondary" onClick={exportWorkflow}>
              <Download size={15} /> Export JSON
            </button>
            <label className="secondary upload-button">
              <Upload size={15} /> Import JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={event => importWorkflow(event.target.files?.[0])}
              />
            </label>
            <button
              className="secondary"
              onClick={saveWorkflow}
              disabled={busy === 'save'}
            >
              <Save size={15} /> {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              className="primary"
              onClick={runWorkflow}
              disabled={busy === 'run'}
            >
              <Play size={15} /> {busy === 'run' ? 'Running…' : 'Run'}
            </button>
          </div>
        </header>

        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button className="icon-button" onClick={() => setNotice('')}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className="tabbar">
          <button
            className={activeTab === 'editor' ? 'tab active' : 'tab'}
            onClick={() => setActiveTab('editor')}
          >
            <WorkflowIcon size={15} /> Workflow
          </button>
          <button
            className={activeTab === 'runs' ? 'tab active' : 'tab'}
            onClick={() => setActiveTab('runs')}
          >
            <Activity size={15} /> Runs{' '}
            <span className="count">{runs.length}</span>
          </button>
        </div>

        {activeTab === 'editor' ? (
          <>
            <div className="editor-layout">
              <section className="canvas-panel">
                <div className="canvas-heading">
                  <div>
                    <strong>Workflow canvas</strong>
                    <span>Connect nodes to define what happens next.</span>
                  </div>
                  <span className="live-pill">
                    <span /> Draft
                  </span>
                </div>
                <div className="canvas">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                    onPaneClick={() => setSelectedNodeId(null)}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                    minZoom={0.25}
                    maxZoom={1.5}
                  >
                    <Background color="#303934" gap={22} size={1} />
                    <MiniMap pannable zoomable />
                    <Controls />
                  </ReactFlow>
                </div>
                <div className="node-toolbar">
                  {nodeCatalog.map(item => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.kind}
                        className="node-add"
                        onClick={() => addNode(item.kind, item.label)}
                        title={item.hint}
                      >
                        <Icon size={15} />
                        <span>{item.label}</span>
                        <Plus size={13} />
                      </button>
                    );
                  })}
                </div>
              </section>
              <aside className="inspector">
                <div className="panel-title">
                  <div>
                    <strong>Node settings</strong>
                    <span>Configure the selected step</span>
                  </div>
                  <CircleHelp size={16} />
                </div>
                {selectedNode ? (
                  <>
                    <label className="field-label">Node name</label>
                    <input
                      className="text-input"
                      value={selectedNode.data.label}
                      onChange={event =>
                        setNodes(current =>
                          current.map(node =>
                            node.id === selectedNodeId
                              ? {
                                  ...node,
                                  data: {
                                    ...node.data,
                                    label: event.target.value,
                                  },
                                }
                              : node
                          )
                        )
                      }
                    />
                    <label className="field-label">Node type</label>
                    <div className="node-type">
                      <span>{selectedNode.data.kind}</span>
                      <span className="tiny">Built-in node</span>
                    </div>
                    <label className="field-label">Configuration (JSON)</label>
                    <textarea
                      className="config-editor"
                      value={configText}
                      onChange={event => setConfigText(event.target.value)}
                      spellCheck={false}
                    />
                    <button className="primary full" onClick={applyNodeConfig}>
                      <Check size={15} /> Apply configuration
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => {
                        setNodes(current =>
                          current.filter(node => node.id !== selectedNodeId)
                        );
                        setEdges(current =>
                          current.filter(
                            edge =>
                              edge.source !== selectedNodeId &&
                              edge.target !== selectedNodeId
                          )
                        );
                        setSelectedNodeId(null);
                      }}
                    >
                      <Trash2 size={14} /> Remove node
                    </button>
                    <p className="help-text">
                      Node configuration is validated again by the server before
                      execution. Arbitrary code is not executed.
                    </p>
                  </>
                ) : (
                  <div className="inspector-empty">
                    <Braces size={25} />
                    <strong>Select a node</strong>
                    <p>
                      Choose a node on the canvas to edit its settings, or add a
                      step from the toolbar.
                    </p>
                  </div>
                )}
              </aside>
            </div>
            {runOutput && (
              <section className="output-panel">
                <div className="panel-title">
                  <strong>Latest execution output</strong>
                  <span className="success-label">Completed</span>
                </div>
                <pre>{pretty(runOutput)}</pre>
              </section>
            )}
          </>
        ) : (
          <section className="runs-panel">
            {runs.length === 0 ? (
              <div className="empty-state">
                <Activity size={30} />
                <strong>No runs yet</strong>
                <p>Run a workflow to see its execution history here.</p>
              </div>
            ) : (
              runs.map(run => (
                <article className="run-row" key={run.id}>
                  <div className="run-icon">
                    <Check size={16} />
                  </div>
                  <div className="run-info">
                    <strong>{run.workflowName}</strong>
                    <span>{new Date(run.createdAt).toLocaleString()}</span>
                  </div>
                  <span className="success-label">{run.status}</span>
                  <button
                    className="icon-button"
                    onClick={() => setRunOutput(run.output)}
                    title="View output"
                  >
                    <Braces size={16} />
                  </button>
                </article>
              ))
            )}
            {runOutput && (
              <section className="output-panel">
                <div className="panel-title">
                  <strong>Execution details</strong>
                </div>
                <pre>{pretty(runOutput)}</pre>
              </section>
            )}
          </section>
        )}
      </main>

      {assistantOpen && (
        <div className="modal-backdrop" onClick={() => setAssistantOpen(false)}>
          <section
            className="assistant-modal"
            onClick={event => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div className="assistant-icon">
                <Bot size={20} />
              </div>
              <div>
                <strong>Gemini workflow assistant</strong>
                <span>Describe the automation you want to build.</span>
              </div>
              <button
                className="icon-button"
                onClick={() => setAssistantOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <textarea
              className="assistant-input"
              value={assistantPrompt}
              onChange={event => setAssistantPrompt(event.target.value)}
              placeholder="When a new lead is added, check if the email exists, score the lead, draft a personalised email, then send it for my approval…"
            />
            <p className="help-text">
              Gemini drafts the workflow. It will not execute actions or send
              messages. Review the generated nodes before running anything.
            </p>
            <button
              className="primary full"
              onClick={askGemini}
              disabled={busy === 'assistant' || !assistantPrompt.trim()}
            >
              <Sparkles size={16} />{' '}
              {busy === 'assistant'
                ? 'Generating workflow…'
                : 'Generate workflow'}
            </button>
          </section>
        </div>
      )}
      <footer className="footer">
        <span>
          <KeyRound size={13} /> Private workspace
        </span>
        <span>
          <Cloud size={13} /> Saved to your account
        </span>
        <span>
          <FileJson size={13} /> JSON portable
        </span>
      </footer>
    </div>
  );
}

export default App;
