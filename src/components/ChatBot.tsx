import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, MapPin, Paperclip, X, FileText, Image } from 'lucide-react';
import { api } from '../services/api';
import { Message, Location } from '../types';
import { useTranslation } from 'react-i18next';
import { gisService } from '../services/gisfunctions';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ChatBotProps {
  onSearch: () => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  onClear: () => void;
  onLocationsUpdate: (locations: Location[]) => void;
  selectedMapLocation?: [number, number] | null;
  onLocationSelect: (location: Location | null) => void;
  onNewChat: () => void;
  polygonPoints?: [number, number][] | null;
}

const GeoBot: React.FC<ChatBotProps> = ({ 
  onSearch, 
  messages, 
  setMessages, 
  onClear,
  onLocationsUpdate,
  selectedMapLocation,
  onLocationSelect,
  onNewChat,
  polygonPoints
}) => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');   // partial response being typed
  const [statusText, setStatusText] = useState('');         // "Analyzing…" / "Querying…"
  const [attachedFile, setAttachedFile] = useState<{ file: File; preview: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);    // lets us cancel in-flight request
  // Geometry captured from draw tools — stored locally so it survives onClear()
  const pendingGeometry = useRef<{
    location: [number, number] | null;
    polygon:  [number, number][] | null;
  }>({ location: null, polygon: null });

  // Last geometry that was actually sent to the backend — used to re-apply
  // spatial context on distance/buffer follow-up queries ("100m buffer only")
  const lastSentGeometry = useRef<{
    location: [number, number] | null;
    polygon:  [number, number][] | null;
  }>({ location: null, polygon: null });

  // Keywords that indicate the user wants a spatial refinement using the
  // previously selected point — re-send last geometry in these cases
  const _DISTANCE_KEYWORDS = [
    'meter', 'metre', 'km', 'kilometer', 'kilometre',
    'buffer', 'radius', 'within', 'distance', '100m', '500m', '1km',
  ];
  const { t } = useTranslation();

  // ── File attachment helpers ─────────────────────────────────────────────────
  const ALLOWED_TYPES = ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf'];

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      alert('Unsupported file type. Please upload PNG, JPG, WEBP, GIF, or PDF.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      alert('File too large. Maximum size is 20 MB.');
      return;
    }
    const preview = file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : '';
    setAttachedFile({ file, preview });
    // Reset so same file can be re-attached
    e.target.value = '';
  }, []);

  const clearAttachment = useCallback(() => {
    if (attachedFile?.preview) URL.revokeObjectURL(attachedFile.preview);
    setAttachedFile(null);
  }, [attachedFile]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);
  useEffect(() => { scrollToBottom(); }, [statusText]);
  useEffect(() => { scrollToBottom(); }, [streamingText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!selectedMapLocation) return;
    pendingGeometry.current = { location: selectedMapLocation, polygon: null };
    setMessages(prev => [...prev, {
      text: `📍 Point selected on map`,
      isUser: false,
      isLocation: true,
    }]);
    setInput(`Find plots near this location`);
    inputRef.current?.focus();
  }, [selectedMapLocation]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!polygonPoints || polygonPoints.length <= 2) return;
    pendingGeometry.current = { location: null, polygon: polygonPoints };
    setMessages(prev => [...prev, {
      text: `🔷 Polygon drawn on map`,
      isUser: false,
      isLocation: true,
    }]);
    setInput(`Find plots within the drawn area`);
    inputRef.current?.focus();
  }, [polygonPoints]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel any in-flight stream on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Core send logic — streaming version
  const sendMessage = (
    overrideText?: string,
    overrideLocation?: [number, number] | null,
    overridePolygon?: [number, number][] | null,
    fileOverride?: { file: File; preview: string } | null,
  ) => {
    const currentFile = fileOverride !== undefined ? fileOverride : attachedFile;
    const userMessage = overrideText ?? input.trim();
    if ((!userMessage && !currentFile) || loading) return;

    if (!overrideText) setInput('');
    if (currentFile) clearAttachment();
    setLoading(true);
    setStreamingText('');
    setStatusText('');

    // Safety net: force-reset loading after 90s in case SSE stream dies silently on proxy (Render)
    const safetyTimer = setTimeout(() => {
      setLoading(false);
      setStreamingText('');
      setStatusText('');
    }, 90_000);

    onLocationsUpdate([]);
    onLocationSelect(null);

    const displayText = userMessage || (currentFile ? `📎 ${currentFile.file.name}` : '');
    const newMessage  = { text: displayText, isUser: true };
    const chatHistory = [...messages, newMessage];
    setMessages(chatHistory);

    const loc     = overrideLocation !== undefined ? overrideLocation  : selectedMapLocation;
    const polygon = overridePolygon  !== undefined ? overridePolygon   : polygonPoints;

    let accumulated = '';
    let resultData: any = null;

    // ── Branch: file upload vs normal chat ──────────────────────────────────
    const callbacks = {
      onStatus: (text: string) => {
        setStatusText(text);
      },

      onTextDelta: (chunk: string) => {
        accumulated += chunk;
        setStreamingText(accumulated);
        setStatusText('');
      },

      onResult: (data: any) => {
        resultData = data;
      },

      onError: (message: string) => {
        clearTimeout(safetyTimer);
        setMessages(prev => [...prev, { text: message, isUser: false }]);
        setStreamingText('');
        setStatusText('');
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 0);
      },

      onDone: () => {
        clearTimeout(safetyTimer);
        // Always reset loading — even if anything below throws
        try {
          // Commit the streamed text as a proper chat bubble (no isSummary — needs markdown rendering)
          if (accumulated) {
            setMessages(prev => [
              ...prev,
              { text: accumulated, isUser: false },
            ]);
          }
          setStreamingText('');
          setStatusText('');

          if (resultData?.results?.length > 0) {
            const r            = resultData.results[0];
            const attrs        = r.attributes        ?? [];
            const stats        = r.stats             ?? [];
            const distVals     = r.distinct_values   ?? [];
            const toolExecuted = r.tool_executed     ?? false;

            if (attrs.length > 0) {
              // GIS features returned — update map + table + zoom
              onLocationsUpdate(attrs);
              onSearch();
              setTimeout(() => gisService.zoomToFeatures(attrs), 100);
            } else if (toolExecuted) {
              // Tool ran but returned 0 features (e.g. stats query, count only,
              // or a filter that matched nothing) → clear the map
              onLocationsUpdate([]);
            }
            // toolExecuted=false means Haiku answered conversationally → preserve map
          }
        } catch (err) {
          console.error('[onDone] Error processing result:', err);
        } finally {
          setLoading(false);
          setTimeout(() => inputRef.current?.focus(), 0);
        }
      },
    };

    let controller: AbortController;
    if (currentFile) {
      controller = api.uploadFileStream(
        currentFile.file,
        userMessage || 'Extract all geometries and show them on the map',
        callbacks,
      );
    } else {
      controller = api.sendChatMessageStream(chatHistory, loc, polygon, callbacks);
    }

    abortRef.current = controller;
  };

  const handleSend = () => {
    if ((input.trim() || attachedFile) && !loading) {
      let loc  = pendingGeometry.current.location;
      let poly = pendingGeometry.current.polygon;
      const file = attachedFile;
      pendingGeometry.current = { location: null, polygon: null };

      // If no fresh geometry but the message is a distance/buffer refinement,
      // re-send the last used geometry so the spatial filter stays active
      if (!loc && !poly) {
        const msgLow = input.trim().toLowerCase();
        const isDistanceQuery = _DISTANCE_KEYWORDS.some(kw => msgLow.includes(kw));
        if (isDistanceQuery && lastSentGeometry.current.location) {
          loc = lastSentGeometry.current.location;
        }
      }

      // Save whichever geometry we're about to send
      if (loc || poly) {
        lastSentGeometry.current = { location: loc, polygon: poly };
      }

      onClear();
      sendMessage(undefined, loc, poly, file);
    }
  };


  return (
    <div className="dashboard-card h-full flex flex-col">
      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center">
          <button 
            onClick={onNewChat}
            className="w-6 h-6 bg-[rgb(28,96,154)] bg-opacity-10 dark:bg-opacity-20 rounded-lg flex items-center justify-center mr-2 hover:bg-opacity-20 dark:hover:bg-opacity-30 transition-all"
            title={t('chat.newChat')}
          >
            <Bot size={16} className="text-[rgb(28,96,154)]" />
          </button>
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{t('chat.title')}</h2>
          </div>
        </div>
      </div>

      <div className="flex-1 p-3 overflow-y-auto scrollbar-custom">
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.isUser ? 'justify-end' : 'justify-start'} mb-2`}
          >
            <div
              className={`p-2 rounded-2xl ${
                message.isUser
                  ? 'max-w-[70%] bg-[rgb(28,96,154)] text-white rounded-br-none text-[0.8rem]'
                  : message.isLocation
                    ? 'max-w-[70%] bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 flex items-center gap-2 rounded-bl-none border border-green-200 dark:border-green-800 text-[0.8rem]'
                    : message.isSummary
                      ? 'max-w-[70%] bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 flex items-center gap-2 rounded-bl-none border border-blue-200 dark:border-blue-800 italic text-[0.8rem]'
                      : 'w-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 rounded-bl-none border border-blue-200 dark:border-blue-800 text-[0.8rem]'
              }`}
            >
              {message.isLocation && <MapPin size={14} />}
              {message.isUser || message.isLocation || message.isSummary
                ? message.text
                : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // Tables
                      table: ({ children }) => (
                        <div className="overflow-x-auto my-2">
                          <table className="min-w-full text-xs border-collapse border border-blue-200 dark:border-blue-700">{children}</table>
                        </div>
                      ),
                      thead: ({ children }) => <thead className="bg-blue-100 dark:bg-blue-900/40">{children}</thead>,
                      th: ({ children }) => <th className="border border-blue-200 dark:border-blue-700 px-2 py-1 font-semibold text-left">{children}</th>,
                      td: ({ children }) => <td className="border border-blue-200 dark:border-blue-700 px-2 py-1">{children}</td>,
                      // Lists
                      ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
                      li: ({ children }) => <li className="ml-2">{children}</li>,
                      // Inline
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      code: ({ children }) => <code className="bg-blue-100 dark:bg-blue-900/60 rounded px-1 font-mono text-[0.75rem]">{children}</code>,
                      // Paragraphs — remove default block margin so bubbles stay compact
                      p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                    }}
                  >
                    {message.text}
                  </ReactMarkdown>
                )
              }
            </div>
          </div>
        ))}
        {/* Streaming text bubble — appears while Sonnet is typing */}
        {loading && streamingText && (
          <div className="flex justify-start mb-2">
            <div className="p-2 rounded-2xl w-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 rounded-bl-none border border-blue-200 dark:border-blue-800 text-[0.8rem]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-2">
                      <table className="min-w-full text-xs border-collapse border border-blue-200 dark:border-blue-700">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => <thead className="bg-blue-100 dark:bg-blue-900/40">{children}</thead>,
                  th: ({ children }) => <th className="border border-blue-200 dark:border-blue-700 px-2 py-1 font-semibold text-left">{children}</th>,
                  td: ({ children }) => <td className="border border-blue-200 dark:border-blue-700 px-2 py-1">{children}</td>,
                  ul: ({ children }) => <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="ml-2">{children}</li>,
                  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                  p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                }}
              >
                {streamingText}
              </ReactMarkdown>
              <span className="inline-block w-0.5 h-3.5 ml-0.5 bg-blue-400 dark:bg-blue-500 animate-pulse align-text-bottom" />
            </div>
          </div>
        )}

        {/* Status label — shows for ALL loading states until streaming text begins.
            GIS queries show the specific stage ("Analyzing…" / "Querying GIS…");
            conversational queries fall back to "Thinking…" */}
        {loading && !streamingText && (
          <div className="flex justify-start mb-2">
            <div className="px-3 py-1.5 rounded-full bg-[rgb(28,96,154)]/8 dark:bg-[rgb(28,96,154)]/15 border border-[rgb(28,96,154)]/20 flex items-center gap-2">
              <span className="flex gap-0.5">
                {[0, 150, 300].map(d => (
                  <span
                    key={d}
                    className="w-1.5 h-1.5 rounded-full bg-[rgb(28,96,154)] animate-bounce"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
              </span>
              <span className="text-xs text-[rgb(28,96,154)] dark:text-[rgb(28,96,154)]/80 font-medium">
                {statusText || 'Thinking…'}
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
      <div className="border-t border-gray-200 dark:border-gray-700 p-3">
        {/* File attachment preview chip */}
        {attachedFile && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700">
            {attachedFile.file.type.startsWith('image/') ? (
              <>
                <Image size={14} className="text-blue-500 shrink-0" />
                {attachedFile.preview && (
                  <img src={attachedFile.preview} alt="preview"
                    className="h-8 w-8 object-cover rounded border border-blue-200" />
                )}
              </>
            ) : (
              <FileText size={14} className="text-blue-500 shrink-0" />
            )}
            <span className="text-xs text-blue-700 dark:text-blue-300 truncate flex-1 font-medium">
              {attachedFile.file.name}
            </span>
            <span className="text-xs text-blue-400 shrink-0">
              {(attachedFile.file.size / 1024).toFixed(0)} KB
            </span>
            <button
              onClick={clearAttachment}
              className="text-blue-400 hover:text-blue-600 shrink-0"
              title="Remove attachment"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,image/*,application/pdf"
          className="hidden"
          onChange={handleFileSelect}
        />

        <div className="flex gap-2">
          {/* + / attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title="Attach image or PDF"
            className={`w-9 h-9 shrink-0 flex items-center justify-center rounded-xl border transition-colors
              ${loading
                ? 'border-gray-200 dark:border-gray-700 text-gray-300 cursor-not-allowed'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-[rgb(28,96,154)] hover:text-[rgb(28,96,154)] hover:bg-blue-50 dark:hover:bg-blue-900/20'
              }`}
          >
            <Paperclip size={16} />
          </button>

          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder={attachedFile ? 'Ask about this file… (or send to extract map features)' : selectedMapLocation || polygonPoints ? t('chat.locationPlaceholder') : t('chat.placeholder')}
            className="flex-1 p-1.5 border rounded-xl text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-[rgb(28,96,154)] focus:ring-opacity-50 placeholder-gray-400 dark:placeholder-gray-500"
            disabled={loading}
            autoFocus
          />
          <button
            onClick={handleSend}
            title={t('chat.send')}
            className={`${
              loading
                ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'
                : (attachedFile
                    ? 'bg-purple-600 hover:bg-purple-700'
                    : 'bg-[rgb(28,96,154)] hover:bg-[rgb(28,96,154)]/90')
            } text-white p-2 rounded-xl transition-colors w-10 h-10 flex items-center justify-center`}
            disabled={loading}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default GeoBot;