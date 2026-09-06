import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { HelpCircle, CheckCircle, Loader2, Plus, X, AlertCircle } from 'lucide-react';
import type { SimilarityCheckResponse, QuerySubmission, QueryType as TypesQueryType, FarcasterChannel, ScaleConfig, DateConfig } from '../lib/types';
import {
  type SignerStatus,
  fetchApprovedSignerStatus,
  shouldClientCast,
  questionSnapUrl,
  composeCastInMiniApp,
  anchorCastHash,
  preopenComposeTab,
  openWebComposeIntent,
  discardComposeTab,
} from '../lib/clientCast';
import { apiTypeToLocal, type QueryType } from '../lib/queryTypeMap';

import { VectorService } from '../services/VectorService';
import { MAX_Q_LENGTH } from '../lib/consts';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';

// Circled numbers for MC options (① through ⑩)
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

// Calculate formatted cast length (same logic as backend)
function calculateCastLength(stem: string, queryType: QueryType, options: string[]): number {
  if (queryType !== 'multiple_choice' && queryType !== 'checkbox') {
    return stem.length;
  }
  const filteredOptions = options.filter(opt => opt.trim());
  if (filteredOptions.length === 0) {
    return stem.length;
  }
  const optionsText = filteredOptions
    .slice(0, CIRCLED_NUMBERS.length)
    .map((opt, i) => `${CIRCLED_NUMBERS[i]} ${opt}`)
    .join('\n');
  return `${stem}\n\n${optionsText}`.length;
}

import CompactQuestionCard from './CompactQuestionCard';
import './CreateQueryModal.css';

// Prefill payload for fork mode. The modal hydrates its form state from this on
// open and submits with `forked_from` set so the server skips duplicate gates.
export interface CreateQueryPrefill {
  forkedFrom: string;
  sourceStem: string;
  stem: string;
  type: QueryType;
  options?: string[];
  scaleConfig?: ScaleConfig;
  dateConfig?: DateConfig;
}

interface CreateQueryModalProps {
  isOpen: boolean;
  onClose: () => void;
  prefill?: CreateQueryPrefill;
}

const CreateQueryModal: React.FC<CreateQueryModalProps> = ({ isOpen, onClose, prefill: propPrefill }) => {
  const navigate = useNavigate();
  const { user, isAuthenticated, getAuthToken, isMiniApp } = useAuth();
  const { settings } = useSettings();
  // Internal fork state — initialized from the propPrefill, but can be upgraded
  // mid-session when the user clicks "fork" on a similarity-suggestion card.
  const [forkPrefill, setForkPrefill] = useState<CreateQueryPrefill | null>(propPrefill ?? null);
  const prefill = forkPrefill;
  const [question, setQuestion] = useState('');
  const [queryType, setQueryType] = useState<QueryType>('text');
  const [isAnon, setIsAnon] = useState(false);
  // Tri-state signer status: true = approved signer, false = confirmed none,
  // 'unknown' = could not determine (auth/network failure), null = not fetched
  // yet. Only `false` is "confirmed no signer" — handleSubmit re-resolves
  // null/'unknown' before picking a cast path (see shouldClientCast).
  const [hasApprovedSigner, setHasApprovedSigner] = useState<SignerStatus | null>(null);


  // Multiple Choice State
  const [options, setOptions] = useState(['Yes', 'No']); // Default to binary-ish
  const [autoFocusIdx, setAutoFocusIdx] = useState<number | null>(null);

  // Date State
  const [dateIncludeTime, setDateIncludeTime] = useState<boolean>(false);

  // Scale State
  const [scaleMin, setScaleMin] = useState<number>(0);
  const [scaleMinInput, setScaleMinInput] = useState<string>('0');
  const [scaleMax, setScaleMax] = useState<number>(5);
  const [scaleMaxInput, setScaleMaxInput] = useState<string>('5');
  const [scaleValue, setScaleValue] = useState<number | null>(null);
  const [scaleLabels, setScaleLabels] = useState({ start: 'Low', end: 'High' });

  // Channel State
  const [selectedChannel, setSelectedChannel] = useState<FarcasterChannel | null>(null);
  const [showChannelSearch, setShowChannelSearch] = useState(false);
  const [channelSearchQuery, setChannelSearchQuery] = useState('');
  const [channelResults, setChannelResults] = useState<FarcasterChannel[]>([]);
  const [isSearchingChannels, setIsSearchingChannels] = useState(false);
  const channelSearchRef = useRef<HTMLDivElement>(null);

  // Track which inputs the user has explicitly edited (so onFocus select-all only fires for defaults)
  const touchedInputsRef = useRef<Set<string>>(new Set());
  const optionDefaultsRef = useRef<string[]>(['Yes', 'No']);
  const scaleDefaultsRef = useRef({ start: 'Low', end: 'High', size: '5' });



  const [similarityResult, setSimilarityResult] = useState<SimilarityCheckResponse | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isTyping, setIsTyping] = useState(false); // Immediate reaction
  const [_isParsing, setIsParsing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Set when the server rejected the stem as a duplicate: offer a fresh wave on it.
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  // "opening composer…" — modal stays mounted while composeCast suspends the miniapp
  const [isOpeningComposer, setIsOpeningComposer] = useState(false);
  const [avatarCache, setAvatarCache] = useState<Map<number, string>>(new Map());

  const MIN_LENGTH = 10;

  // No-signer users: miniapp gets composeCast; web gets farcaster.xyz share-intent.
  // isSignerLocked survives only as a cast-path input (not an anon force).
  const isSignerLocked = hasApprovedSigner === false;

  // Fetch signer status when modal opens
  useEffect(() => {
    if (!isOpen || !isAuthenticated) {
      setHasApprovedSigner(null);
      return;
    }
    let cancelled = false;
    fetchApprovedSignerStatus(getAuthToken()).then((status) => {
      if (!cancelled) setHasApprovedSigner(status);
    });
    return () => { cancelled = true; };
  }, [isOpen, isAuthenticated, getAuthToken]);

  // Re-sync internal fork state with the prop when the modal reopens.
  // Without this, an existing forkPrefill could leak across opens.
  useEffect(() => {
    if (isOpen) {
      setForkPrefill(propPrefill ?? null);
    }
  }, [isOpen, propPrefill]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';

      // Hydrate from prefill (fork mode). Runs once per open transition.
      if (prefill) {
        setQuestion(prefill.stem);
        setQueryType(prefill.type);
        if (prefill.options && prefill.options.length > 0) {
          setOptions(prefill.options);
        }
        if (prefill.scaleConfig) {
          setScaleMin(prefill.scaleConfig.min);
          setScaleMinInput(String(prefill.scaleConfig.min));
          setScaleMax(prefill.scaleConfig.max);
          setScaleMaxInput(String(prefill.scaleConfig.max));
          const startLabel = prefill.scaleConfig.customLabels?.find(l => l.value === prefill.scaleConfig!.min)?.label;
          const endLabel = prefill.scaleConfig.customLabels?.find(l => l.value === prefill.scaleConfig!.max)?.label;
          setScaleLabels({
            start: startLabel ?? 'Low',
            end: endLabel ?? 'High',
          });
        }
        if (prefill.dateConfig) {
          setDateIncludeTime(!!prefill.dateConfig.include_time);
        }
        // All prefilled inputs are user-intent, not defaults — mark touched so
        // focus-select-all doesn't wipe them.
        touchedInputsRef.current.add('stem');
        (prefill.options ?? []).forEach((_, i) => touchedInputsRef.current.add(`option-${i}`));
      }
    } else {
      document.body.style.overflow = 'unset';

      // Reset state when closed
      setQuestion('');
      setQueryType('text');
      setIsAnon(false);
      setOptions(['Yes', 'No']);
      setScaleMin(0);
      setScaleMinInput('0');
      setScaleMax(5);
      setScaleMaxInput('5');
      setScaleValue(null);
      setScaleLabels({ start: 'Low', end: 'High' });
      setDateIncludeTime(false);
      setSimilarityResult(null);
      setIsChecking(false);
      setIsTyping(false);
      setIsParsing(false);
      setIsSubmitting(false);
      setIsOpeningComposer(false);
      setSubmitError(null);
      setSelectedChannel(null);
      setShowChannelSearch(false);
      setChannelSearchQuery('');
      setChannelResults([]);
      setHasApprovedSigner(null);
      setForkPrefill(null);
      touchedInputsRef.current.clear();
      optionDefaultsRef.current = ['Yes', 'No'];
      scaleDefaultsRef.current = { start: 'Low', end: 'High', size: '5' };
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, prefill]);

  // Real-time similarity check using the same thresholds as server
  // - Client shows suggestions at 0.85+ (SIMILARITY_THRESHOLD)
  // - Server blocks duplicates at 0.98+ (DUPLICATE_THRESHOLD)
  // This provides early feedback while allowing similar questions
  // Rate limit: 30 req/min, so we use 1s debounce to stay well under the limit
  useEffect(() => {
    // Fork mode: user has already declared intent to re-ask this question.
    // The similarity check would just match the source and gate us out.
    if (prefill) {
      setIsTyping(false);
      setIsChecking(false);
      setSimilarityResult({ status: 'unique', results: [] });
      return;
    }

    if (question.length === 0) {
      setIsTyping(false);
      setIsChecking(false);
      setSimilarityResult(null);
      return;
    }

    setIsTyping(true);
    setSimilarityResult(null); // Clear previous results while typing

    const timer = setTimeout(async () => {
      setIsTyping(false);
      if (question.length >= MIN_LENGTH) {
        setIsChecking(true);
        try {
          const token = getAuthToken();
          const data = await VectorService.checkSimilarity(question, token);
          setSimilarityResult(data);
          
          // Fetch avatars for similar questions
          if (data.results && data.results.length > 0) {
            setAvatarCache(prevCache => {
              const fidsToFetch = new Set<number>();
              data.results.forEach(result => {
                // @ts-expect-error - metadata structure varies
                const fid = result.metadata?.coiner_fid;
                if (fid && !prevCache.has(fid)) {
                  fidsToFetch.add(fid);
                }
              });
              
              if (fidsToFetch.size > 0) {
                // Fetch avatars in parallel (without awaiting - update cache when ready)
                const avatarPromises = Array.from(fidsToFetch).map(async (fid) => {
                  try {
                    const response = await fetch(`/api/user/${fid}/avatar`);
                    if (response.ok) {
                      const { avatarUrl } = await response.json();
                      return { fid, avatarUrl };
                    }
                  } catch (e) {
                    console.error(`Failed to fetch avatar for FID ${fid}:`, e);
                  }
                  return { fid, avatarUrl: null };
                });
                
                Promise.all(avatarPromises).then(avatarResults => {
                  setAvatarCache(currentCache => {
                    const newCache = new Map(currentCache);
                    avatarResults.forEach(({ fid, avatarUrl }) => {
                      if (avatarUrl) {
                        newCache.set(fid, avatarUrl);
                      }
                    });
                    return newCache;
                  });
                });
              }
              
              // Return unchanged cache immediately
              return prevCache;
            });
          }
        } catch (e) {
          console.error('Similarity check failed, allowing proceed:', e);
          // Fail open - let server do final check
          setSimilarityResult({ status: 'unique', results: [] });
        } finally {
          setIsChecking(false);
        }
      } else {
        setIsChecking(false);
      }
    }, 1000); // 1s debounce — rate limit bumped to 30/min, similarity check fails open

    return () => clearTimeout(timer);
  }, [question, getAuthToken, prefill]);

  // Channel search with debounce
  useEffect(() => {
    if (!channelSearchQuery || channelSearchQuery.length < 1) {
      setChannelResults([]);
      return;
    }

    setIsSearchingChannels(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/channels/search?q=${encodeURIComponent(channelSearchQuery)}&limit=8`);
        if (response.ok) {
          const data = await response.json();
          setChannelResults(data.channels || []);
        }
      } catch (e) {
        console.error('Channel search failed:', e);
        setChannelResults([]);
      } finally {
        setIsSearchingChannels(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [channelSearchQuery]);

  // Close channel search on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (channelSearchRef.current && !channelSearchRef.current.contains(event.target as Node)) {
        setShowChannelSearch(false);
      }
    };

    if (showChannelSearch) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showChannelSearch]);

  const handleSubmit = async () => {
    // Prevent double-submission
    if (isSubmitting) {
      return;
    }

    if (!isAuthenticated || !user?.fid) {
      setSubmitError('You must be logged in to create queries');
      return;
    }

    if (question.length < MIN_LENGTH) {
      setSubmitError('Question must be at least 10 characters');
      return;
    }

    const token = getAuthToken();
    if (!token) {
      setSubmitError('Authentication token not found. Please log in again.');
      return;
    }

    // Debounce: prevent rapid re-submissions (3 second cooldown)
    const lastSubmitKey = 'qbase_last_question_submit';
    const lastSubmit = localStorage.getItem(lastSubmitKey);
    const now = Date.now();
    if (lastSubmit && now - parseInt(lastSubmit) < 3000) {
      setSubmitError('Please wait a moment before submitting again.');
      return;
    }
    localStorage.setItem(lastSubmitKey, now.toString());

    setIsSubmitting(true);
    setSubmitError(null);
    console.log('[Create Query] Starting submission');
    console.log('[Create Query] Question type:', queryType);

    // Map local queryType to API QueryType
    const typeMap: Record<QueryType, TypesQueryType> = {
      'text': 'text',
      'multiple_choice': 'mc',
      'checkbox': 'checkbox',
      'scale': 'scale',
      'date': 'date',
    };
    const apiType: TypesQueryType = typeMap[queryType];

    // Signerless Phase 3/4: pick the cast path.
    // - Confirmed approved signer → server casts as the user (cast_mode 'server').
    // - Confirmed no signer → cast_mode 'client': miniapp users composeCast from
    //   their own client; web users get a farcaster.xyz/~/compose tab (stays
    //   unanchored for v1; the question page offers a 'cast this question'
    //   affordance).
    // - Still unresolved at submit (modal-open fetch pending or failed) →
    //   re-check now rather than guessing. A user WITH a signer must never be
    //   pushed onto the client path by a slow or failed status fetch: on web
    //   that is a popup-blocked tab and no cast at all.
    // - Anon questions always go server-side: @4n0n casts them. The client
    //   path would post from the user's own account and unmask them.
    let signerStatus: SignerStatus | null = hasApprovedSigner;
    if (!isAnon && signerStatus !== true && signerStatus !== false) {
      signerStatus = await fetchApprovedSignerStatus(token);
      setHasApprovedSigner(signerStatus);
    }
    const useClientCast = !isAnon && shouldClientCast(signerStatus, isMiniApp);
    const isWebClientCast = useClientCast && !isMiniApp;

    // Web share-intent: grab the tab now, while the click's user activation is
    // still fresh. The create request below takes seconds (AI classification),
    // and a window.open after it is popup-blocked with no error.
    const composeTab = isWebClientCast ? preopenComposeTab() : null;

    // Build the submission payload
    const payload: QuerySubmission = {
      stem: question,
      type: apiType,
      isAnon,
      includeEmbed: settings.includeEmbedInQuestionCasts ?? true,
      ...(useClientCast ? { cast_mode: 'client' as const } : {}),
    };

    // Add channel if selected
    if (selectedChannel) {
      payload.channel_id = selectedChannel.id;
    }

    // Fork lineage — server validates the source exists and that the fork
    // actually changes shape (type/options/scale_config) vs source.
    if (prefill?.forkedFrom) {
      payload.forked_from = prefill.forkedFrom;
    }

    // Add type-specific fields
    if ((queryType === 'multiple_choice' || queryType === 'checkbox') && options.length > 0) {
      payload.a_options = options.filter(opt => opt.trim() !== '');
    } else if (queryType === 'scale') {
      payload.scale_config = {
        min: scaleMin,
        max: scaleMax,
        step: 1,
        customLabels: [
          { value: scaleMin, label: scaleLabels.start },
          { value: scaleMax, label: scaleLabels.end },
        ],
      };
    } else if (queryType === 'date') {
      payload.date_config = { include_time: dateIncludeTime };
    }

    console.log('[Create Query] Payload:', payload);

    try {
      // Submit the question and wait for the response
      const response = await fetch('/api/queries', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const result = await response.json();
        console.log('[Create Query] Question created successfully:', result.id);

        // Set flag for FeedPage to know it should refresh when visited
        // This works regardless of how user navigates back to the feed
        sessionStorage.setItem('qbase_question_created', Date.now().toString());

        if (useClientCast) {
          // Plain snap URL — the snap carries the full stem for the client
          // path, so no ?compact=1&token=… (server-only HMAC gate).
          const snapUrl = questionSnapUrl(result.id);

          if (isWebClientCast) {
            // Web share-intent path: point the pre-opened tab at
            // farcaster.xyz/~/compose (clipboard fallback inside). The question
            // stays unanchored (v1 accepted); the question page offers a
            // persistent 'cast this question' affordance.
            await openWebComposeIntent(composeTab, result.cast_text, snapUrl);
          } else {
            // Miniapp client cast path: open the composer as the user. Keep the
            // modal mounted with an "opening composer…" state — composeCast
            // suspends the miniapp until it resolves.
            setIsOpeningComposer(true);
            const castHash = await composeCastInMiniApp({
              text: result.cast_text,
              embedUrl: snapUrl,
              channelKey: selectedChannel?.id,
            });
            if (castHash) {
              // Anchor the cast we just posted (Phase 2 endpoint). Non-critical.
              await anchorCastHash(result.id, castHash, token);
            }
            // null (cancelled / composer failed): navigate anyway — the question
            // exists and the question page offers a "cast this question" affordance.
          }

          onClose();
          navigate(`/question/${result.id}`, {
            state: {
              isNewQuestion: true,
              castPending: false, // no server cast coming on the client path
            }
          });
        } else {
          // Close modal and navigate directly to the new question
          onClose();
          navigate(`/question/${result.id}`, {
            state: {
              isNewQuestion: true,
              castPending: true // Show toast that cast is still posting
            }
          });
        }
      } else {
        discardComposeTab(composeTab);
        // Server returns either JSON { error: "..." } or plain text. Try both.
        const raw = await response.text().catch(() => '');
        let serverMsg = '';
        try {
          const parsed = JSON.parse(raw);
          serverMsg = parsed?.error || '';
          // Both dedup gates (exact stem, 0.98 vector) carry existing_id: the
          // same question can carry a new wave instead of a duplicate row.
          setDuplicateOf(typeof parsed?.existing_id === 'string' ? parsed.existing_id : null);
        } catch {
          serverMsg = raw.trim();
        }
        if (response.status === 429) {
          setSubmitError(serverMsg || 'Too many requests. Please wait a moment and try again.');
        } else if (response.status === 403) {
          setSubmitError(serverMsg || 'You don\'t have permission to do that.');
        } else if (response.status === 503) {
          setSubmitError(serverMsg || 'Something went wrong. Please try again.');
        } else {
          setSubmitError(serverMsg || `Failed to create question (HTTP ${response.status}). Please try again.`);
        }
        console.error('[Create Query] Server rejected submission', { status: response.status, body: raw });
        setIsSubmitting(false);
      }
    } catch (error) {
      discardComposeTab(composeTab);
      console.error('[Create Query] Request error:', error);
      setSubmitError('Failed to create question. Please try again.');
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  // Select-all on focus for inputs that haven't been user-edited
  const handleFocusSelectAll = (key: string) => (e: React.FocusEvent<HTMLInputElement>) => {
    if (!touchedInputsRef.current.has(key)) {
      e.target.select();
    }
  };

  // Multiple Choice Handlers
  const handleOptionChange = (index: number, value: string) => {
    touchedInputsRef.current.add(`option-${index}`);
    const newOptions = [...options];
    newOptions[index] = value;
    setOptions(newOptions);
  };

  const addOption = () => {
    if (options.length < 10) {
      setOptions([...options, '']);
      setAutoFocusIdx(options.length); // index of the new option
    }
  };

  const removeOption = (index: number) => {
    if (options.length > 2) {
      const newOptions = options.filter((_, i) => i !== index);
      setOptions(newOptions);
    }
  };

  // Detect incomplete stems (simple client-side heuristic for early warning)
  // Server does full LLM-based classification on submit
  const looksLikeIncompleteStem = question.trim().endsWith(':') || 
    /^(would you rather|choose between|pick one|select one|rank these|this or that)/i.test(question.trim());
  
  // Calculate cast length for length warning
  const castLength = calculateCastLength(question, queryType, options);
  const isOverCastLimit = castLength > MAX_Q_LENGTH;

  const showSuggestions = !isTyping && !isChecking && similarityResult && similarityResult.results.length > 0 && !prefill;
  // Show form for 'unique' (no matches) or 'similar' (matches but not duplicates)
  // Only hide form for 'duplicate' status (98%+ match)
  // Fork mode: form is always shown — the user has already declared intent to re-ask the source.
  const showForm = prefill
    ? question.length >= MIN_LENGTH
    : !isTyping && !isChecking && similarityResult && similarityResult.status !== 'duplicate' && question.length >= MIN_LENGTH;
  const showWarning = !isTyping && !isChecking && question.length > 0 && question.length < MIN_LENGTH;
  const showIncompleteWarning = !isTyping && !isChecking && looksLikeIncompleteStem && 
    (queryType === 'multiple_choice' || queryType === 'checkbox') && options.filter(o => o.trim()).length < 2;
  const showCastLengthWarning = showForm && isOverCastLimit;

  // Client-side validation that mirrors the server's rejection rules, so users
  // see "needs ≥2 options" or "options can't be blank" before clicking submit
  // instead of round-tripping for a generic toast.
  const filledOptions = options.filter(o => o.trim() !== '');
  const clientValidationError: string | null = (() => {
    if (question.trim().length < MIN_LENGTH) return null; // length warning already shown
    if (queryType === 'multiple_choice' || queryType === 'checkbox') {
      if (filledOptions.length < 2) return 'Add at least 2 options before submitting.';
      if (options.some(o => o !== '' && o.trim() === '')) return 'Options can\'t be blank — remove or fill them.';
    }
    if (isOverCastLimit) return 'Question is too long for a Farcaster cast.';
    return null;
  })();

  return (
    <>
      <div className="create-query-modal-overlay">
        <div className="create-query-modal-container" onClick={(e) => e.stopPropagation()}>

        <div className="modal-content-wrapper">
          <div className="question-input-container">
            <textarea
              className="question-input"
              placeholder="ask anything..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              autoFocus
            />
            <div className="input-actions">
              <div className={`help-icon ${isChecking || isTyping ? 'checking' : ''} ${showSuggestions ? 'has-matches' : ''} ${showForm ? 'unique' : ''} ${showWarning ? 'warning' : ''}`}>
                {(isChecking || isTyping) && <Loader2 size={18} className="spin" />}
                {!isChecking && !isTyping && !showSuggestions && !showForm && !showWarning && <HelpCircle size={18} strokeWidth={3} />}
                {showSuggestions && <span className="match-count">{similarityResult?.results.length}</span>}
                {showForm && <CheckCircle size={18} strokeWidth={3} />}
                {showWarning && <AlertCircle size={18} strokeWidth={3} />}
              </div>
            </div>
            {showWarning && (
              <div className="input-warning-text">
                Question must be at least {MIN_LENGTH} characters
              </div>
            )}
            {showIncompleteWarning && (
              <div className="input-warning-text" style={{ color: '#ff9800' }}>
                This looks like a template question. Add at least 2 options to complete it.
              </div>
            )}
            {showCastLengthWarning && (
              <div className="input-warning-text" style={{ color: '#ff9800' }}>
                Cast exceeds {MAX_Q_LENGTH} chars ({castLength}). Options will be omitted unless you have Farcaster Pro.
              </div>
            )}
          </div>

          {/* Magic Auto-Complete Suggestions */}
          <div className={`suggestions-container ${showSuggestions ? 'visible' : ''}`}>
            {showSuggestions && (
              <div className="suggestions-list visible">
                {similarityResult?.results.map((result) => {
                  // @ts-expect-error - metadata structure varies
                  const questionText = result.metadata?.text || result.metadata?.stem || `Question #${result.id.substring(0, 8)}...`;
                  // @ts-expect-error - metadata structure varies
                  const authorName = result.metadata?.coiner_fname;
                  // @ts-expect-error - metadata structure varies
                  const authorFid = result.metadata?.coiner_fid;
                  // Get avatar from cache if available
                  const avatarUrl = authorFid ? avatarCache.get(authorFid) : undefined;
                  
                  return (
                    <CompactQuestionCard
                      key={result.id}
                      id={result.id}
                      questionText={questionText}
                      authorName={authorName}
                      authorFid={authorFid}
                      avatarUrl={avatarUrl}
                      matchScore={result.score}
                      showMatchBadge={true}
                      onClick={() => {
                        onClose();
                        navigate(`/question/${result.id}`);
                      }}
                      onReask={() => {
                        onClose();
                        navigate(`/create-poll?question=${result.id}`);
                      }}
                      onFork={async () => {
                        // Fetch full question to hydrate type/options/scale_config —
                        // the similarity payload only carries stem + author metadata.
                        try {
                          const r = await fetch(`/api/queries/${result.id}`);
                          if (!r.ok) {
                            setSubmitError('Could not load that question to fork');
                            return;
                          }
                          const q = await r.json() as {
                            id: string; stem: string; type: TypesQueryType;
                            a_options?: string[]; scale_config?: import('../lib/types').ScaleConfig;
                            date_config?: import('../lib/types').DateConfig;
                            coiner_fname?: string;
                          };
                          setForkPrefill({
                            forkedFrom: q.id,
                            sourceStem: q.stem,
                            stem: q.stem,
                            type: apiTypeToLocal(q.type),
                            options: q.a_options,
                            scaleConfig: q.scale_config,
                            dateConfig: q.date_config,
                          });
                          // Re-hydrate form state. The hydration effect runs on
                          // [isOpen, prefill] — `prefill` is the alias for forkPrefill,
                          // so updating it triggers the rehydrate.
                          setQuestion(q.stem);
                          setQueryType(apiTypeToLocal(q.type));
                          if (q.a_options && q.a_options.length > 0) setOptions(q.a_options);
                          if (q.scale_config) {
                            setScaleMin(q.scale_config.min);
                            setScaleMinInput(String(q.scale_config.min));
                            setScaleMax(q.scale_config.max);
                            setScaleMaxInput(String(q.scale_config.max));
                          }
                          if (q.date_config) {
                            setDateIncludeTime(!!q.date_config.include_time);
                          }
                        } catch (e) {
                          console.error('[Fork] Failed to load source question:', e);
                          setSubmitError('Could not load that question to fork');
                        }
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Full Form - Revealed only when unique */}
          <div className={`query-form-container ${showForm ? 'visible' : ''}`}>
            
            {/* Channel and Anon Row */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {/* Channel Selector */}
              <div className="channel-selector-section" ref={channelSearchRef} style={{ flex: 1 }}>
                {selectedChannel ? (
                  <div className="selected-channel">
                    <div className="selected-channel-info">
                      {selectedChannel.image_url && (
                        <img 
                          src={selectedChannel.image_url} 
                          alt={selectedChannel.name}
                          className="channel-image"
                        />
                      )}
                      <span className="channel-name">/{selectedChannel.id}</span>
                    </div>
                    <button 
                      className="remove-channel-btn"
                      onClick={() => setSelectedChannel(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <button 
                    className="add-channel-btn"
                    onClick={() => setShowChannelSearch(true)}
                  >
                    <span>+ add /channel</span>
                  </button>
                )}
                
                {showChannelSearch && !selectedChannel && (
                  <div className="channel-search-dropdown">
                    <input
                      type="text"
                      className="channel-search-input"
                      placeholder="Search channels..."
                      value={channelSearchQuery}
                      onChange={(e) => setChannelSearchQuery(e.target.value)}
                      autoFocus
                    />
                    {isSearchingChannels && (
                      <div className="channel-search-loading">
                        <Loader2 size={16} className="spin" />
                      </div>
                    )}
                    {channelResults.length > 0 && (
                      <div className="channel-results">
                        {channelResults.map((channel) => (
                          <button
                            key={channel.id}
                            className="channel-result-item"
                            onClick={() => {
                              setSelectedChannel(channel);
                              setShowChannelSearch(false);
                              setChannelSearchQuery('');
                              setChannelResults([]);
                            }}
                          >
                            {channel.image_url && (
                              <img 
                                src={channel.image_url} 
                                alt={channel.name}
                                className="channel-result-image"
                              />
                            )}
                            <div className="channel-result-info">
                              <span className="channel-result-name">/{channel.id}</span>
                              {channel.follower_count && (
                                <span className="channel-result-followers">
                                  {channel.follower_count.toLocaleString()} followers
                                </span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {channelSearchQuery && !isSearchingChannels && channelResults.length === 0 && (
                      <div className="channel-no-results">No channels found</div>
                    )}
                  </div>
                )}
              </div>

              {/* Anonymous Toggle */}
              <div className={`anon-toggle-section ${isAnon ? 'active' : ''}`}>
                <label className="anon-toggle-label">
                  <span className="anon-label-text">
                    {isSignerLocked ? 'anon (no signer)' : 'post anon'}
                  </span>
                  <div className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={isAnon}
                      onChange={(e) => {
                        setIsAnon(e.target.checked);
                      }}
                    />
                    <span className="toggle-slider" />
                  </div>
                </label>
              </div>
            </div>

            <div className="type-selector">
              {(['text', 'multiple_choice', 'checkbox', 'scale', 'date'] as QueryType[]).map((type) => {
                return (
                  <button
                    key={type}
                    className={`type-option ${queryType === type ? 'active' : ''}`}
                    onClick={() => setQueryType(type)}
                  >
                    {type === 'multiple_choice' ? 'Select One' :
                     type === 'checkbox' ? 'Select Many' :
                     type.charAt(0).toUpperCase() + type.slice(1)}
                  </button>
                );
              })}
            </div>

            {queryType === 'text' && (
              <div className="options-section">
                <div className="section-label">Example Response</div>
                <textarea
                  className="option-input"
                  disabled
                  placeholder="Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
                  style={{ minHeight: '130px', resize: 'none' }}
                />
              </div>
            )}

            {queryType === 'multiple_choice' && (
              <div className="options-section">
                <div className="section-label">Options (select one)</div>
                {options.map((option, index) => (
                  <div key={index} className="option-row">
                    <input
                      type="text"
                      className="option-input"
                      value={option}
                      onChange={(e) => handleOptionChange(index, e.target.value)}
                      onFocus={(e) => { handleFocusSelectAll(`option-${index}`)(e); setAutoFocusIdx(null); }}
                      placeholder={`Option ${index + 1}`}
                      autoFocus={index === autoFocusIdx}
                    />
                    {options.length > 2 && (
                      <button className="remove-option-btn" onClick={() => removeOption(index)}>
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
                {options.length < 10 && (
                  <button className="add-option-btn" onClick={addOption}>
                    <Plus size={14} /> Add Option
                  </button>
                )}
                {filledOptions.length < 2 && (
                  <div className="options-hint">Add at least 2 options.</div>
                )}
              </div>
            )}

            {queryType === 'checkbox' && (
              <div className="options-section">
                <div className="section-label">Options (select many)</div>
                {options.map((option, index) => (
                  <div key={index} className="option-row">
                    <input
                      type="text"
                      className="option-input"
                      value={option}
                      onChange={(e) => handleOptionChange(index, e.target.value)}
                      onFocus={(e) => { handleFocusSelectAll(`option-${index}`)(e); setAutoFocusIdx(null); }}
                      placeholder={`Option ${index + 1}`}
                      autoFocus={index === autoFocusIdx}
                    />
                    {options.length > 2 && (
                      <button className="remove-option-btn" onClick={() => removeOption(index)}>
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
                {options.length < 10 && (
                  <button className="add-option-btn" onClick={addOption}>
                    <Plus size={14} /> Add Option
                  </button>
                )}
                {filledOptions.length < 2 && (
                  <div className="options-hint">Add at least 2 options.</div>
                )}
              </div>
            )}

            {queryType === 'scale' && (
              <div className="options-section">
                <div className="scale-config">
                  <div className="section-label">Range</div>
                  <div className="scale-size-selector">
                    <input
                      type="number"
                      className="scale-size-input"
                      min={2}
                      max={100}
                      value={scaleMax - scaleMin + 1}
                      onChange={(e) => {
                        touchedInputsRef.current.add('scale-size');
                        const val = parseInt(e.target.value, 10);
                        if (Number.isFinite(val) && val >= 2 && val <= 100) {
                          const newMax = scaleMin + val - 1;
                          setScaleMax(newMax);
                          setScaleMaxInput(String(newMax));
                        }
                      }}
                      onFocus={handleFocusSelectAll('scale-size')}
                    />
                    <span className="scale-size-hint">{(scaleMax - scaleMin) > 5 ? '(slider)' : '(buttons)'}</span>
                  </div>
                </div>

                <div className="scale-labels-config">
                  <div className="label-input-group">
                    <label>Minimum</label>
                    <input
                      type="number"
                      className="scale-label-input"
                      value={scaleMinInput}
                      onChange={(e) => {
                        touchedInputsRef.current.add('scale-min');
                        setScaleMinInput(e.target.value);
                        const val = parseInt(e.target.value, 10);
                        if (Number.isFinite(val)) {
                          setScaleMin(val);
                          if (scaleMax < val + 2) {
                            const newMax = val + 2;
                            setScaleMax(newMax);
                            setScaleMaxInput(String(newMax));
                          }
                        }
                      }}
                      onBlur={() => {
                        if (!scaleMinInput || !Number.isFinite(parseInt(scaleMinInput, 10))) {
                          setScaleMinInput(String(scaleMin));
                        }
                      }}
                      onFocus={handleFocusSelectAll('scale-min')}
                    />
                  </div>
                  <div className="label-input-group">
                    <label>Maximum</label>
                    <input
                      type="number"
                      className="scale-label-input"
                      value={scaleMaxInput}
                      onChange={(e) => {
                        touchedInputsRef.current.add('scale-max');
                        setScaleMaxInput(e.target.value);
                        const val = parseInt(e.target.value, 10);
                        if (Number.isFinite(val) && val >= scaleMin + 2) {
                          setScaleMax(val);
                        }
                      }}
                      onBlur={() => {
                        if (!scaleMaxInput || !Number.isFinite(parseInt(scaleMaxInput, 10))) {
                          setScaleMaxInput(String(scaleMax));
                        } else {
                          const val = parseInt(scaleMaxInput, 10);
                          if (val < scaleMin + 2) {
                            const newMax = scaleMin + 2;
                            setScaleMax(newMax);
                            setScaleMaxInput(String(newMax));
                          }
                        }
                      }}
                      onFocus={handleFocusSelectAll('scale-max')}
                    />
                  </div>
                </div>

                <div className="scale-labels-config">
                  <div className="label-input-group">
                    <label>Start Label</label>
                    <input
                      type="text"
                      className="scale-label-input"
                      value={scaleLabels.start}
                      onChange={(e) => { touchedInputsRef.current.add('scale-start'); setScaleLabels({ ...scaleLabels, start: e.target.value }); }}
                      onFocus={handleFocusSelectAll('scale-start')}
                    />
                  </div>
                  <div className="label-input-group">
                    <label>End Label</label>
                    <input
                      type="text"
                      className="scale-label-input"
                      value={scaleLabels.end}
                      onChange={(e) => { touchedInputsRef.current.add('scale-end'); setScaleLabels({ ...scaleLabels, end: e.target.value }); }}
                      onFocus={handleFocusSelectAll('scale-end')}
                    />
                  </div>
                </div>

                <div className="section-label">Preview</div>
                {(scaleMax - scaleMin) <= 5 ? (
                  <>
                    <div className="scale-selector">
                      {Array.from({ length: scaleMax - scaleMin + 1 }, (_, i) => scaleMin + i).map((val) => (
                        <button
                          key={val}
                          className={`scale-point ${scaleValue === val ? 'active' : ''}`}
                          onClick={() => setScaleValue(val)}
                          style={{
                            width: val === Math.round((scaleMin + scaleMax) / 2) ? 40 : 32,
                            height: val === Math.round((scaleMin + scaleMax) / 2) ? 40 : 32,
                            opacity: scaleValue === val ? 1 : 0.3 + ((val - scaleMin) % 4) * 0.1
                          }}
                        />
                      ))}
                    </div>
                    <div className="scale-labels">
                      <span>{scaleLabels.start}</span>
                      <span>{scaleLabels.end}</span>
                    </div>
                  </>
                ) : (
                  <div className="scale-slider-preview">
                    <span className="scale-slider-label">{scaleLabels.start}</span>
                    <input
                      type="range"
                      min={scaleMin}
                      max={scaleMax}
                      value={scaleValue ?? Math.round((scaleMin + scaleMax) / 2)}
                      onChange={(e) => setScaleValue(parseInt(e.target.value, 10))}
                      className="scale-slider-input"
                    />
                    <span className="scale-slider-label">{scaleLabels.end}</span>
                  </div>
                )}
              </div>
            )}

            {queryType === 'date' && (
              <div className="options-section">
                <div className="section-label">Date format</div>
                <label className="date-include-time-toggle" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={dateIncludeTime}
                    onChange={(e) => setDateIncludeTime(e.target.checked)}
                  />
                  <span>Include time</span>
                </label>
                <div className="section-label" style={{ marginTop: 12 }}>Preview</div>
                <input
                  type={dateIncludeTime ? 'datetime-local' : 'date'}
                  className="option-input"
                  disabled
                />
              </div>
            )}

            {/* Embed info blurb */}
            <p className="embed-info-blurb">
              Your question will be cast to Farcaster with a snap embed, letting others answer directly.{' '}
              <a href="/settings" onClick={(e) => { e.preventDefault(); onClose(); navigate('/settings'); }}>
                Change in settings
              </a>
            </p>
          </div>
        </div>

        {submitError && (
          <div className="submit-error-banner" role="alert" aria-live="assertive">
            <AlertCircle size={18} strokeWidth={2.5} />
            <span>{submitError}</span>
            {duplicateOf && (
              <button
                type="button"
                className="submit-error-dismiss"
                style={{ width: 'auto', padding: '0 8px', fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={() => { onClose(); navigate(`/create-poll?question=${duplicateOf}`); }}
              >
                ask again as a new poll
              </button>
            )}
            <button
              type="button"
              className="submit-error-dismiss"
              onClick={() => { setSubmitError(null); setDuplicateOf(null); }}
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="modal-footer">
          {showForm && (
            <button
              className="submit-btn"
              onClick={handleSubmit}
              disabled={!isAuthenticated || isSubmitting || isOpeningComposer || !!clientValidationError}
              title={clientValidationError ?? undefined}
            >
              {isOpeningComposer
                ? 'opening composer…'
                : isSubmitting
                ? (prefill && question.trim() === prefill.sourceStem.trim() ? 'forking...' : 'submitting...')
                : (prefill && question.trim() === prefill.sourceStem.trim() ? 'fork' : 'submit')}
            </button>
          )}
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
        </div>

        </div>
      </div>
    </>
  );
};

export default CreateQueryModal;
