import { useState, useRef, useEffect, useCallback } from 'react';
import './BackroomPage.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export default function BackroomPage() {
  const [adminSecret, setAdminSecret] = useState<string>(
    () => sessionStorage.getItem('backroom_secret') || ''
  );
  const [authenticated, setAuthenticated] = useState<boolean>(
    () => !!sessionStorage.getItem('backroom_secret')
  );
  const [secretInput, setSecretInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking, scrollToBottom]);

  useEffect(() => {
    if (authenticated) {
      inputRef.current?.focus();
    } else {
      secretInputRef.current?.focus();
    }
  }, [authenticated]);

  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault();
    if (secretInput.trim()) {
      sessionStorage.setItem('backroom_secret', secretInput.trim());
      setAdminSecret(secretInput.trim());
      setAuthenticated(true);
      setSecretInput('');
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isThinking) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsThinking(true);
    setError(null);

    try {
      const res = await fetch('/api/q/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminSecret}`,
        },
        body: JSON.stringify({ message, conversationId }),
      });

      if (res.status === 401 || res.status === 403) {
        sessionStorage.removeItem('backroom_secret');
        setAuthenticated(false);
        setAdminSecret('');
        setError('Invalid secret. Try again.');
        setIsThinking(false);
        return;
      }

      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }

      const data = await res.json();

      if (data.conversationId) {
        setConversationId(data.conversationId);
      }

      const assistantMsg: Message = {
        id: data.messageId || crypto.randomUUID(),
        role: 'assistant',
        content: data.response,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsThinking(false);
      inputRef.current?.focus();
    }
  };

  // Auth gate
  if (!authenticated) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <form onSubmit={handleAuth} className="flex flex-col items-center gap-4">
          <p className="text-neutral-600 text-xs tracking-widest uppercase">The Backroom</p>
          <input
            ref={secretInputRef}
            type="password"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            placeholder="Enter secret"
            className="bg-neutral-900 border border-neutral-800 text-neutral-200 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-teal-700 w-64 text-center placeholder-neutral-700"
            autoComplete="off"
          />
          {error && <p className="text-red-500/70 text-xs">{error}</p>}
          <button
            type="submit"
            className="text-neutral-600 text-xs hover:text-teal-500 transition-colors cursor-pointer"
          >
            enter
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col h-screen">
      {/* Title */}
      <div className="pt-4 pb-2 text-center">
        <p className="text-neutral-700 text-xs tracking-widest uppercase">The Backroom</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 pb-2 backroom-scrollbar">
        <div className="max-w-2xl mx-auto flex flex-col gap-3 py-4">
          {messages.length === 0 && (
            <p className="text-neutral-800 text-sm text-center mt-20">
              Start a conversation with Q.
            </p>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-neutral-800 text-neutral-200 rounded-br-sm'
                    : 'bg-teal-950/40 text-teal-100/90 border border-teal-900/30 rounded-bl-sm'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {isThinking && (
            <div className="flex justify-start">
              <div className="bg-teal-950/20 border border-teal-900/20 rounded-xl rounded-bl-sm px-4 py-2.5 text-sm text-teal-600/70">
                <span className="inline-flex gap-1">
                  <span className="animate-pulse">Q is thinking</span>
                  <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                  <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                  <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                </span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-center py-1">
          <p className="text-red-500/60 text-xs">{error}</p>
        </div>
      )}

      {/* Input */}
      <div className="p-4 border-t border-neutral-900">
        <form onSubmit={sendMessage} className="max-w-2xl mx-auto flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Say something..."
            disabled={isThinking}
            className="flex-1 bg-neutral-900 border border-neutral-800 text-neutral-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-teal-800 placeholder-neutral-700 disabled:opacity-50"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={isThinking || !input.trim()}
            className="bg-teal-900/50 text-teal-300 rounded-lg px-4 py-2.5 text-sm hover:bg-teal-800/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
