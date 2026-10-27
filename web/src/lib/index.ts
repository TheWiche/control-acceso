import type { Api } from './api';
import { demoApi } from './demoApi';
import { isConfigured, liveApi } from './liveApi';

export const DEMO = import.meta.env.VITE_DEMO === 'true';
export const CONFIG_MISSING = !DEMO && !isConfigured;
export const api: Api = DEMO ? demoApi : liveApi;
