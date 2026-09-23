// Provider catalog (shared by server + client). Model lists are suggestions only;
// users can type any model ID their key has access to, or load the live list with "Test key".
// Sources/verification dates recorded in docs/decisions.md (D-004).
export const PROVIDERS = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-...', keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.5'],
    defaultModel: 'gpt-5.6-sol',
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    keyHint: 'sk-ant-...', keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-5',
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyHint: 'AIza...', keyUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.7-flash'],
    defaultModel: 'gemini-3.8-flash',
  },
  {
    id: 'xai', label: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1',
    keyHint: 'xai-...', keyUrl: 'https://console.x.ai',
    models: ['grok-4.6', 'grok-4.5', 'grok-4.3'],
    defaultModel: 'grok-4.6',
  },
  {
    id: 'openrouter', label: 'OpenRouter (any model)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-...', keyUrl: 'https://openrouter.ai/keys',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5', 'google/gemini-3.8-flash', 'x-ai/grok-4.6'],
    defaultModel: 'openai/gpt-5.6-sol',
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '',
    keyHint: 'API key', keyUrl: '', customBaseUrl: true,
    models: [], defaultModel: '',
  },
  {
    id: 'demo', label: 'Demo (sample output, no key)', kind: 'demo', baseUrl: '', noKey: true,
    models: ['demo-writer'], defaultModel: 'demo-writer',
  },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;
export const MODEL_ID_RE = /^[A-Za-z0-9._:\/@+-]{1,120}$/;
