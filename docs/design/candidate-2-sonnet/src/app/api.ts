// app/api.ts -- the review app's only door to the backend: the typed client derived from shared/api/contract.
// Same origin as the backend (served by it), so no CORS; the token cookie is set by the server on first load.
import { createClient, type Client } from "../shared/api/contract";
export const api: Client = createClient("", "", fetch.bind(globalThis));
