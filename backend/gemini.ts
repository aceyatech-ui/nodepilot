type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function generateWorkflowWithGemini(
  apiKey: string,
  prompt: string,
  currentWorkflow: unknown,
  generate: boolean
): Promise<unknown> {
  const system = `You are NodePilot's workflow design assistant. Return ONLY valid JSON, no markdown fences.
Create workflows using ONLY these node kinds: trigger, set, if, gemini, log.
Output shape: {"nodes":[{"id":"unique-id","type":"default","position":{"x":100,"y":100},"data":{"label":"Readable name","kind":"trigger|set|if|gemini|log","config":{}}}],"edges":[{"id":"edge-id","source":"node-id","target":"node-id","sourceHandle":"true|false"}]}.
Every workflow must include exactly one trigger node. Use set config {"fields":{...}}; if config {"path":"field.nested","operator":"equals|not_equals|contains|is_set","value":"..."}; gemini config {"prompt":"..."}; log config {}.
For IF nodes, outgoing edges must use sourceHandle "true" or "false". Do not invent HTTP, email, shell, code execution, payment, or destructive action nodes. Never claim an external action has been performed. Keep workflows small and safe.`;
  const userContent = generate
    ? `Build a workflow from this request: ${prompt}\nCurrent workflow for context: ${JSON.stringify(currentWorkflow ?? {})}`
    : `You are executing a Gemini node. Task: ${prompt}\nInput data: ${JSON.stringify(currentWorkflow ?? {})}\nReturn the useful result as concise plain text.`;
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: userContent }] }],
        generationConfig: generate
          ? {
              responseMimeType: 'application/json',
              temperature: 0.2,
              maxOutputTokens: 5000,
            }
          : { temperature: 0.4, maxOutputTokens: 1200 },
      }),
      signal: AbortSignal.timeout(30000),
    }
  );
  const payload = (await response.json()) as GeminiResponse;
  if (!response.ok)
    throw new Error(
      payload.error?.message || `Gemini request failed (${response.status}).`
    );
  const text = payload.candidates?.[0]?.content?.parts
    ?.map(part => part.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  if (!generate) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'Gemini did not return valid workflow JSON. Try a more specific request.'
    );
  }
  if (!isRecord(parsed))
    throw new Error('Gemini returned an invalid workflow object.');
  return parsed;
}
