export interface Tag {
  id: number;
  name: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface CreateLinkPayload {
  link: string;
  title?: string;
  tags?: number[];
  newTags?: string[];
}

export interface UpdateLinkPayload {
  title?: string;
  tags?: number[];
  newTags?: string[];
}

export interface ExistingLink {
  id: number;
  title: string | null;
  link: string;
  tags: Tag[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly fieldErrors: Record<string, string[]> = {},
    /**
     * True when apiFetch refused before dispatching anything: no token, an
     * unusable base URL, or a missing host grant. Status 0 alone cannot tell
     * those apart from a dead network, and they need opposite advice — one is
     * fixed on the options page, the other by reconnecting.
     */
    public readonly local = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
