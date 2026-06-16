/**
 * api.ts — GeoAI frontend API service.
 *
 * sendChatMessageStream POSTs to /api/chat and reads the SSE stream.
 * Events: status | text_delta | result | error | [DONE]
 */

import axios from 'axios';
import { Location } from '../types';

// ---------------------------------------------------------------------------
// Axios instance
// ---------------------------------------------------------------------------
const axiosInstance = axios.create({
  baseURL: '/api',
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
});

axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      throw new Error(
        error.response.data?.error ||
        error.response.data?.message ||
        'Server error occurred'
      );
    } else if (error.request) {
      throw new Error('No response from server. Please check your connection.');
    } else {
      throw new Error('Failed to make request. Please try again.');
    }
  }
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One result entry from the Claude agent. */
export interface AgentResult {
  description:      string;
  message:          string;
  attributes:       Location[];  // processed features with coordinates — for map + table
  features:         any[];       // raw ArcGIS ESRI-JSON features
  stats?:           any[];       // present for aggregation queries
  distinct_values?: string[];    // present for distinct-value queries
}

/** Full response returned by /api/chat. */
export interface ChatResponse {
  results?: AgentResult[];
  error?:   string;
}

interface SupportEmailResponse {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export const api = {

  /**
   * Send a chat message and consume the SSE stream from the Claude agent.
   *
   * Calls onStatus for processing stage labels, onTextDelta for each streamed
   * text chunk, onResult when the full result payload arrives, and onDone when
   * the stream closes.  Returns an AbortController so the caller can cancel.
   */
  sendChatMessageStream: (
    chatHistory:     { text: string; isUser: boolean }[],
    selectedLocation?: [number, number] | null,
    polygonPoints?:    [number, number][] | null,
    callbacks: {
      onStatus:    (text: string)        => void;
      onTextDelta: (chunk: string)       => void;
      onResult:    (data: ChatResponse)  => void;
      onError:     (message: string)     => void;
      onDone:      ()                    => void;
    } = { onStatus: () => {}, onTextDelta: () => {}, onResult: () => {}, onError: () => {}, onDone: () => {} },
  ): AbortController => {
    if (!chatHistory || chatHistory.length === 0) {
      callbacks.onError('Chat history cannot be empty');
      return new AbortController();
    }

    const hasPolygon = Array.isArray(polygonPoints) && polygonPoints.length > 2;
    const flipped    = hasPolygon ? polygonPoints!.map(([x, y]) => [y, x]) : [];

    const controller = new AbortController();

    // ── Browser console: log mode + outgoing request ──────────────────────
    fetch('/api/mode').then(r => r.json()).then(d => {
      const mode = d.mode ?? 'API';
      const icon = mode === 'MCP' ? '🖥' : '⚡';
      const style = 'color:#1C609A;font-weight:bold;font-size:13px';
      console.group(`${icon} GeoAI Request — ${mode} mode`);
      console.log('%c  User Message', style, chatHistory[chatHistory.length - 1]?.text ?? '');
      console.log('%c  Tools        ', style, 'query_layer, get_field_info');
      console.log('%c  Transport    ', style, mode === 'MCP' ? 'JSON-RPC 2.0 over stdio (subprocess)' : 'Direct Python in-process call');
      if (selectedLocation) console.log('%c  Point Geom   ', style, selectedLocation);
      if (hasPolygon)       console.log('%c  Polygon Rings', style, polygonPoints);
      console.groupEnd();
    }).catch(() => {});

    (async () => {
      try {
        const res = await fetch('/api/chat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  controller.signal,
          body: JSON.stringify({
            history:     chatHistory,
            coordinates: selectedLocation ?? null,
            polygon: hasPolygon
              ? { rings: [flipped], spatialReference: { wkid: 4326 } }
              : null,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          callbacks.onError(body?.error ?? `Server error ${res.status}`);
          callbacks.onDone();
          return;
        }

        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();
        let   buffer  = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';           // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();

            if (payload === '[DONE]') {
              callbacks.onDone();
              return;
            }

            try {
              const event = JSON.parse(payload);
              switch (event.type) {
                case 'status':
                  console.log(`  ⏳ [SSE status]     ${event.text}`);
                  callbacks.onStatus(event.text);
                  break;
                case 'text_delta':
                  callbacks.onTextDelta(event.text);
                  break;
                case 'result': {
                  const r = event.data?.results?.[0];
                  if (r) {
                    console.group('  ✅ [SSE result]');
                    console.log('  Features returned :', r.attributes?.length ?? 0);
                    console.log('  Tool executed     :', r.tool_executed);
                    if (r.attributes?.length > 0) {
                      console.log('  Sample record     :', r.attributes[0]);
                    }
                    if (r.stats?.length > 0) {
                      console.log('  Stats             :', r.stats);
                    }
                    console.groupEnd();
                  }
                  callbacks.onResult(event.data);
                  break;
                }
                case 'error':
                  console.error(`  ❌ [SSE error]     ${event.text}`);
                  callbacks.onError(event.text);
                  break;
              }
            } catch {
              // Malformed JSON line — ignore
            }
          }
        }

        callbacks.onDone();
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          callbacks.onError(err?.message ?? 'Network error');
        }
        callbacks.onDone();
      }
    })();

    return controller;
  },

  /**
   * Upload an image or PDF file and stream Claude Vision geometry extraction.
   * Same callbacks and AbortController contract as sendChatMessageStream.
   */
  uploadFileStream: (
    file: File,
    message: string,
    callbacks: {
      onStatus:    (text: string)       => void;
      onTextDelta: (chunk: string)      => void;
      onResult:    (data: ChatResponse) => void;
      onError:     (message: string)    => void;
      onDone:      ()                   => void;
    },
  ): AbortController => {
    const controller = new AbortController();

    (async () => {
      try {
        // Read file as base64
        const arrayBuf = await file.arrayBuffer();
        const bytes    = new Uint8Array(arrayBuf);
        let   binary   = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);

        const res = await fetch('/api/upload', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  controller.signal,
          body: JSON.stringify({
            file_data: b64,
            file_type: file.type,
            message,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          callbacks.onError(body?.error ?? `Server error ${res.status}`);
          callbacks.onDone();
          return;
        }

        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();
        let   buffer  = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') { callbacks.onDone(); return; }
            try {
              const event = JSON.parse(payload);
              switch (event.type) {
                case 'status':     callbacks.onStatus(event.text);    break;
                case 'text_delta': callbacks.onTextDelta(event.text); break;
                case 'result':     callbacks.onResult(event.data);    break;
                case 'error':      callbacks.onError(event.text);     break;
              }
            } catch { /* ignore malformed */ }
          }
        }
        callbacks.onDone();
      } catch (err: any) {
        if (err?.name !== 'AbortError') callbacks.onError(err?.message ?? 'Network error');
        callbacks.onDone();
      }
    })();

    return controller;
  },

  sendSupportEmail: async (
    name: string,
    query: string
  ): Promise<SupportEmailResponse> => {
    if (!name.trim() || !query.trim()) throw new Error('Name and query are required');
    const response = await axiosInstance.post<SupportEmailResponse>('/support/email', {
      name, query,
    });
    return response.data;
  },
};
