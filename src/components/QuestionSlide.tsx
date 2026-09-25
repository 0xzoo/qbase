import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { MessageCircle, MessageCircleDashed, Eye, ChevronDown, RefreshCw, ChartColumn, Info, GitFork } from 'lucide-react';
import { sdk } from '@farcaster/miniapp-sdk';
import QuestionRenderer from './QuestionRenderer';
import PollLockBanner from './PollLockBanner';
import WaveStrip from './WaveStrip';
import { useEligibility } from '../hooks/useEligibility';
import { useWorldIdAnswer } from '../hooks/useWorldIdAnswer';


import Toast from './Toast';
import { LikeButton } from './LikeButton';
import { ShareButton } from './ShareButton';
import CompactAnswerCard from './CompactAnswerCard';
import LoadingAnimation from './LoadingAnimation';
import QuestionAnalyticsModal from './QuestionAnalyticsModal';
import CreateQueryModal, { type CreateQueryPrefill } from './CreateQueryModal';
import { apiTypeToLocal } from '../lib/queryTypeMap';
import { useAuth } from '../context/AuthContext';
import { isSnapRenderable } from '../lib/snapEligibility';
import { useUserSettings } from '../hooks/useUserSettings';
import { useAnswersInfinite, useUserAnswerForQuestion } from '../hooks/useAnswers';
import { useToast } from '../hooks/useToast';
import { useFarcasterReplies } from '../hooks/useFarcasterReplies';
import CouncilPanel from './CouncilPanel';

import type { FarcasterReply } from '../hooks/useFarcasterReplies';
import type { Audiences, Answer, AnswerWFname, Query, CheckboxAnswerValue, AnswerData } from '../lib/types';
import { AnswerTypeId } from '../lib/types';
import { formatScaleAnswerValue } from '../lib/scale';
import { formatDateAnswerValue } from '../lib/date';
import { MAX_A_LENGTH, MAX_Q_LENGTH, anon_fid } from '../lib/consts';
import {
  fetchApprovedSignerStatus,
  shouldClientCast,
  questionSnapUrl,
  pollSnapUrl,
  composeCastInMiniApp,
  anchorCastHash,
  openWebComposeIntent,
} from '../lib/clientCast';
import './QuestionSlide.css';

interface QuestionSlideProps {
  question: Query;
  isActive: boolean;
  onRetryCast?: () => void;
  isRetryingCast?: boolean;
  showCastRetry?: boolean;
  isCastPending?: boolean;
}

const QuestionSlide: React.FC<QuestionSlideProps> = ({
  question,
  isActive,
  onRetryCast,
  isRetryingCast = false,
  showCastRetry = false,
  isCastPending = false,
}) => {
  const { settings, updateDefaultAudience } = useUserSettings();
  const { user, getAuthToken, isMiniApp } = useAuth();
  const { toasts, showToast, removeToast } = useToast();
  const location = useLocation();

  // Check for ?view=answers URL param (from snap "View in qbase" button)
  const answersContainerRef = useRef<HTMLDivElement>(null);

  // Local cast pending state — can be cleared by polling when cast completes
  const [castPending, setCastPending] = useState(isCastPending);

  // Poll for cast hash when cast is pending
  useEffect(() => {
    if (!castPending || !isActive) return;
    if (question.casthash) { setCastPending(false); return; }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/queries/${question.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.casthash) {
            question.casthash = data.casthash;
            setCastPending(false);
            clearInterval(interval);
            if (isMiniApp) {
              showToast('Cast posted!', 'success', 5000, {
                label: 'View',
                onClick: () => sdk.actions.viewCast({ hash: data.casthash }),
              });
            }
          }
        }
      } catch { /* ignore poll errors */ }
    }, 3000);

    // Give up after 60s
    const timeout = setTimeout(() => { setCastPending(false); clearInterval(interval); }, 60000);

    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [castPending, isActive, question]);
  

  
  // Wave eligibility — gates live on the question's current wave. A question
  // with no wave in play skips the network probe entirely (canVote=true).
  const eligibility = useEligibility(question, user?.fid);
  // The wave answers are attributed to (absent → direct answers to the question).
  const activePollId = question.current_poll && !question.current_poll.is_closed ? question.current_poll.id : undefined;
  const worldAnswer = useWorldIdAnswer(eligibility.worldGated ? activePollId : undefined, getAuthToken());

  // State
  const [visibility, setVisibility] = useState<Audiences>(settings?.defaultAudience || 'Private');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isSecretInfoOpen, setIsSecretInfoOpen] = useState(false);
  const visibilityControlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDropdownOpen && !isSecretInfoOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (visibilityControlRef.current && !visibilityControlRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
        setIsSecretInfoOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDropdownOpen, isSecretInfoOpen]);
  const [viewMode, setViewMode] = useState<'answer' | 'list'>('answer'); // Default to answer input view
  const [answerValue, setAnswerValue] = useState<unknown>(null);


  const [isSaving, setIsSaving] = useState(false);
  const [existingAnswerId, setExistingAnswerId] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);
  const [forkPrefill, setForkPrefill] = useState<CreateQueryPrefill | null>(null);
  const [forks, setForks] = useState<Array<{
    id: string;
    stem: string;
    type: Query['type'];
    coiner_fname?: string;
    coiner_fid?: number;
  }>>([]);

  // ── MC: Share as Snap + Live Results ──
  const [isCastingSnap, setIsCastingSnap] = useState(false);
  const [snapCastError, setSnapCastError] = useState<string | null>(null);
  const [snapCastDone, setSnapCastDone] = useState(false);
  const [mcResults, setMcResults] = useState<{
    options: string[]; counts: Record<string, number>; total: number;
    user_answer: { option_index: number; option_label: string } | null;
  } | null>(null);
  const [_mcResultsLoading, setMcResultsLoading] = useState(false);
  // Bumped after a successful MC submit so the results-fetch effect re-runs.
  const [mcResultsVersion, setMcResultsVersion] = useState(0);

  const isMcQuestion = question.type === 'mc' && question.a_options && question.a_options.length >= 2;
  const isSnapCast = !!question.casthash;
  const showSnapCastButton = isMcQuestion && !isSnapCast && !castPending;

  // Lazy load forks when slide is active. Empty list = no variants exist; the
  // "Variants" section below the answer feed stays hidden in that case.
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    fetch(`/api/queries/${question.id}/forks`)
      .then(r => r.ok ? r.json() : { forks: [] })
      .then((data: { forks?: typeof forks }) => {
        if (!cancelled) setForks(data.forks ?? []);
      })
      .catch(() => { if (!cancelled) setForks([]); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, question.id]);

  // Lazy load data only when slide is active or nearby
  const {
    answers, loading: answersLoading, refetch: refetchAnswers,
    total: answersTotal, hasNextPage, isFetchingNextPage, fetchNextPage
  } = useAnswersInfinite({
    queryId: isActive ? question.id : undefined,
    uniqueUsers: true,
  });
  
  const userFid = user?.fid;
  const { data: userAnswerData, loading: userAnswerLoading } = useUserAnswerForQuestion(
    isActive ? userFid : undefined, 
    isActive ? question.id : undefined
  );



  // Fetch Farcaster replies
  const { replies: farcasterReplies, engagement: farcasterEngagement, loading: repliesLoading } = useFarcasterReplies(
    isActive ? question?.casthash : undefined,
    user?.fid
  );

  const responses = answers as (Answer | AnswerWFname)[];

  // Persist Farcaster engagement stats when fresh data is fetched
  useEffect(() => {
    if (!farcasterEngagement || !question?.casthash) return;
    if (answersLoading || repliesLoading) return; // Wait for all data to load
    
    // Only sync if we have actual engagement data
    const { likes_count, recasts_count, replies_count } = farcasterEngagement;
    if (likes_count === undefined && recasts_count === undefined && replies_count === undefined) return;

    // Fire-and-forget: persist stats in background
    // Note: pub_answers is NOT sent from the client — it's maintained server-side
    // via /api/queries/:id/sync-counts which uses COUNT(DISTINCT user_id)
    fetch('/api/farcaster/sync-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        castHash: question.casthash,
        likes_count: likes_count ?? 0,
        recasts_count: recasts_count ?? 0,
        replies_count: replies_count ?? 0,
      }),
    }).catch(err => {
      // Silently fail - this is a non-critical background operation
      console.debug('[Farcaster Stats Sync] Failed:', err);
    });
  }, [farcasterEngagement, question?.casthash, answersLoading, repliesLoading]);

  // Display values
  const displayLikes = farcasterEngagement?.likes_count ?? question?.farcaster_likes ?? 0;
  // Use max of qbase answers and Farcaster replies to avoid double counting
  // (public answers with casts appear in both, external FC replies only in Farcaster)
  const farcasterRepliesCount = farcasterEngagement?.replies_count ?? 0;

  // Format stem text
  const displayStem = useMemo(() => {
    if (!question) return '';
    
    const isTemplate = question.taxonomy?.is_template || question.template;
    
    if (isTemplate && question.type === 'mc' && question.a_options && question.a_options.length > 0) {
      const optionsText = question.a_options
        .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
        .join('\n');
      return `${question.stem}\n\n${optionsText}`;
    }
    
    if (isTemplate && question.type === 'scale' && question.scale_config) {
      const { min, max, minLabel, maxLabel } = question.scale_config;
      const scaleText = minLabel && maxLabel 
        ? `(${min} = ${minLabel}, ${max} = ${maxLabel})`
        : `(${min} - ${max})`;
      return `${question.stem}\n\n${scaleText}`;
    }
    
    return question.stem;
  }, [question]);

  // Update visibility when settings load
  useEffect(() => {
    if (question?.taxonomy?.primary_type === 'knowledge') {
      setVisibility('Public');
    } else if (settings?.defaultAudience) {
      setVisibility(settings.defaultAudience);
    }
  }, [settings, question]);

  // Track if we've set initial view mode for this question
  const initialViewModeSetRef = useRef<string | null>(null);
  // Sentinel for infinite scroll — IntersectionObserver triggers loading the next page
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset state when question changes (only depends on question.id)
  useEffect(() => {
    setIsDropdownOpen(false);
    setAnswerValue(null);
    setViewMode('answer'); // Reset to answer input view
    setExistingAnswerId(null);
    setIsUpdating(false);
    initialViewModeSetRef.current = null; // Reset the ref for new question
  }, [question.id]);

  // Switch to the answers list view and scroll to it. Used both by the
  // ?view=answers URL param (from the snap "View in qbase" button) and after
  // a successful answer submission, so the user lands on the list of answers
  // they just contributed to.
  const switchToAnswersList = useCallback(() => {
    setViewMode('list');
    requestAnimationFrame(() => {
      answersContainerRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, []);

  // Read ?view=answers from URL param (from snap "View in qbase" button)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('view') === 'answers') {
      switchToAnswersList();
      // Clean up the URL param so it doesn't persist
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [location.search, switchToAnswersList]);

  // IntersectionObserver for infinite scroll — loads next page when sentinel is near viewport
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || viewMode !== 'list') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: '300px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, viewMode]);

  // Pre-populate answer for identity questions (from server or E2E)
  useEffect(() => {
    // Helper to parse structured JSON value and set the appropriate answer state
    const parseAndSetValue = (valueStr: string, questionType: string | undefined) => {
      try {
        const parsed = JSON.parse(valueStr);
        if (questionType === 'mc' && parsed.index !== undefined) {
          // MC answer - look up option text from index
          const optionText = question.a_options?.[parsed.index];
          setAnswerValue(optionText ?? valueStr);
        } else if (questionType === 'checkbox' && parsed.indices) {
          // Checkbox answer - set the full structured value
          setAnswerValue(parsed);
        } else if (questionType === 'scale' && parsed.index !== undefined) {
          setAnswerValue(parsed.index);
        } else if (questionType === 'date' && typeof parsed.iso === 'string') {
          setAnswerValue({ iso: parsed.iso });
        } else if (parsed.text !== undefined) {
          setAnswerValue(parsed.text);
        } else {
          setAnswerValue(valueStr);
        }
      } catch {
        // Not JSON - for scale, try to parse as number (backwards compat)
        if (questionType === 'scale') {
          const numValue = Number(valueStr);
          if (!isNaN(numValue)) {
            setAnswerValue(numValue);
            return;
          }
        }
        setAnswerValue(valueStr);
      }
    };

    // First check server-side answers
    if (userAnswerData && !userAnswerLoading && userAnswerData.primary_type === 'identity' && userAnswerData.answer) {
      const answer = userAnswerData.answer;
      const valueStr = typeof answer.value === 'string' ? answer.value : String(answer.value);
      
      parseAndSetValue(valueStr, question?.type);
      setVisibility(answer.audience as Audiences);
      setIsUpdating(true);
      setExistingAnswerId(answer.id);
      return;
    }

  }, [userAnswerData, userAnswerLoading, question]);

  // Model answers live in the Council thread (council_responses), not in Answers;
  // legacy oracle_* answer rows are filtered out of the human list here.
  const humanAnswers = useMemo(() =>
    (responses as (Answer | AnswerWFname)[]).filter(
      r => !('answer_source' in r) || !r.answer_source || r.answer_source === 'human'
    ),
    [responses]
  );

  // Sort human answers with user's own at the top
  const sortedResponses = useMemo(() => {
    const userAnswerIds = new Set<string>();
    
    if (userAnswerData) {
      if (userAnswerData.answer) {
        userAnswerIds.add(userAnswerData.answer.id);
      }
      if (userAnswerData.answers) {
        userAnswerData.answers.forEach((a: Answer) => userAnswerIds.add(a.id));
      }
    }
    
    const allResponses = [...(responses || [])];
    
    return allResponses.sort((a, b) => {
      const aIsUser = userAnswerIds.has(a.id) || ('is_own_anon' in a && a.is_own_anon);
      const bIsUser = userAnswerIds.has(b.id) || ('is_own_anon' in b && b.is_own_anon);
      
      if (aIsUser && !bIsUser) return -1;
      if (!aIsUser && bIsUser) return 1;
      
      const aTime = typeof a.created_at === 'number' ? a.created_at : new Date(a.created_at).getTime();
      const bTime = typeof b.created_at === 'number' ? b.created_at : new Date(b.created_at).getTime();
      return bTime - aTime;
    });
  }, [responses, userAnswerData, userFid]);

  // Check if user has any existing answers (including anonymous)
  const hasExistingAnswer = useMemo(() => {
    // Debug logging (temporary - remove after debugging)
    if (userAnswerData) {
      console.log('[QuestionSlide] userAnswerData:', userAnswerData);
    }
    if (userAnswerData) {
      if (userAnswerData.answer) return true;
      if (userAnswerData.answers && userAnswerData.answers.length > 0) return true;
    }
    // Check for anonymous answers in sortedResponses
    const hasOwnAnon = sortedResponses.some(r => 'is_own_anon' in r && r.is_own_anon);
    return hasOwnAnon;
  }, [userAnswerData, sortedResponses]);

  // Check if user has an anonymous answer (for special messaging)
  const hasOwnAnonAnswer = useMemo(() => {
    let result = false;
    // Check userAnswerData first (from user-specific endpoint which has is_own_anon flag)
    if (userAnswerData?.answer) {
      // Check explicit is_own_anon flag
      if ('is_own_anon' in userAnswerData.answer && userAnswerData.answer.is_own_anon) {
        result = true;
      }
      // Also check if it's an Anon audience answer (fallback if is_own_anon not set)
      else if (userAnswerData.answer.audience === 'Anon') {
        result = true;
      }
    }
    if (!result && userAnswerData?.answers) {
      const hasAnon = userAnswerData.answers.some((a: Answer) => 
        ('is_own_anon' in a && a.is_own_anon) || a.audience === 'Anon'
      );
      if (hasAnon) result = true;
    }
    // Also check sortedResponses (in case the general list has it marked)
    if (!result) {
      result = sortedResponses.some(r => 'is_own_anon' in r && r.is_own_anon);
    }
    
    // Debug logging (temporary - remove after debugging)
    console.log('[QuestionSlide] hasOwnAnonAnswer:', result, {
      userAnswerDataAnswer: userAnswerData?.answer,
      sortedResponsesWithOwnAnon: sortedResponses.filter(r => 'is_own_anon' in r && r.is_own_anon)
    });
    
    return result;
  }, [userAnswerData, sortedResponses]);

  // Filter Farcaster replies to remove duplicates
  const filteredFarcasterReplies = useMemo(() => {
    if (!farcasterReplies || farcasterReplies.length === 0) return [];
    
    const qbaseAuthorFids = new Set<number>();
    const qbaseCastHashes = new Set<string>();
    
    responses.forEach((answer) => {
      const userFid = 'user_fid' in answer ? answer.user_fid as number : undefined;
      if (userFid) {
        qbaseAuthorFids.add(userFid);
      }
      if ('casthash' in answer && answer.casthash) {
        qbaseCastHashes.add(answer.casthash as string);
      }
    });
    
    return farcasterReplies.filter((reply) => {
      if (qbaseCastHashes.has(reply.hash)) return false;
      if (qbaseAuthorFids.has(reply.author.fid)) return false;
      return true;
    });
  }, [farcasterReplies, responses]);

  const handleLikeError = (error: string) => {
    showToast(error, 'error');
  };

  // ── MC: Cast as Farcaster Snap ──
  // Who casts depends on what this is:
  //   - poll (a wave in play)           → @polls bot, the poll format's voice
  //   - anon question (coiner = @4n0n)  → @4n0n bot; never the user's account
  //   - question + approved signer      → server casts as the user
  //   - question, no signer             → the user's own client: miniapp
  //     composeCast (hash anchored via /cast-hash) or web share-intent tab
  //     (unanchored, v1) — same split as CreateQueryModal.
  const handleCastAsSnap = async () => {
    setIsCastingSnap(true);
    setSnapCastError(null);
    try {
      const token = getAuthToken();
      if (!token) {
        setSnapCastError('Sign in to share this question');
        return;
      }

      // Cast includes question + options for searchability ("all questions are
      // casts"). Stem-only when that would exceed the non-Pro cast limit — the
      // options live in the snap anyway.
      const withOptions = `${question.stem}\n\n${question.a_options!.map((o, i) =>
        `${['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][i]} ${o}`
      ).join('\n')}`;
      const castText = withOptions.length > MAX_Q_LENGTH ? question.stem : withOptions;
      // A live wave casts its own snap URL so in-feed answers attribute to it.
      const snapUrl = activePollId ? pollSnapUrl(activePollId) : questionSnapUrl(question.id);

      const isPoll = !!activePollId;
      const isAnonQuestion = Number(question.coiner_fid) === anon_fid;
      const useClientCast = !isPoll && !isAnonQuestion
        && shouldClientCast(await fetchApprovedSignerStatus(token), isMiniApp);

      if (useClientCast) {
        if (isMiniApp) {
          const castHash = await composeCastInMiniApp({ text: castText, embedUrl: snapUrl });
          if (!castHash) return; // cancelled / composer failed — not an error
          await anchorCastHash(question.id, castHash, token);
        } else {
          await openWebComposeIntent(null, castText, snapUrl);
          showToast('Composer opened in a new tab', 'success');
          return;
        }
      } else {
        const res = await fetch('/api/farcaster/cast', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            // @polls only for polls, @4n0n for anon questions; otherwise the
            // route casts as the authed user's signer
            ...(isPoll ? { usePollsBot: true } : isAnonQuestion ? { useAnonBot: true } : {}),
            text: castText,
            embeds: [{ url: snapUrl }],
            entityType: 'query',
            entityId: question.id,
            includeSnap: true,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Cast failed (${res.status})`);
        }
      }

      setSnapCastDone(true);
      showToast('Question shared to Farcaster! 📊', 'success');
      // Refresh so casthash + results bar chart appear
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setSnapCastError(err.message || 'Failed to share question');
      showToast('Failed to share question. Try again.', 'error');
    } finally {
      setIsCastingSnap(false);
    }
  };

  // ── Fetch MC results once when snap is cast ──
  useEffect(() => {
    if (!isMcQuestion || !isSnapCast) return;

    let cancelled = false;
    setMcResultsLoading(true);

    const fetchResults = async () => {
      try {
        const params = new URLSearchParams();
        if (user?.fid) params.set('fid', String(user.fid));
        if (question.current_poll) params.set('poll', question.current_poll.id);
        const qs = params.toString();
        const res = await fetch(`/api/answers/results/${question.id}${qs ? `?${qs}` : ''}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMcResults(data);
      } catch (err) {
        console.warn('[MC Results] Failed to fetch:', err);
      } finally {
        if (!cancelled) setMcResultsLoading(false);
      }
    };

    fetchResults();
    return () => { cancelled = true; };
  }, [question.id, isMcQuestion, isSnapCast, user?.fid, mcResultsVersion]);

  const isAnswerValid = () => {
    if (answerValue === null || answerValue === undefined) return false;
    if (typeof answerValue === 'string') return answerValue.trim().length > 0;
    if (Array.isArray(answerValue)) return answerValue.every(v => v && v.toString().trim().length > 0);
    if (question.type === 'date') {
      const iso = (answerValue as AnswerData)?.iso;
      return typeof iso === 'string' && iso.length > 0;
    }
    return true;
  };

  const handleVisibilityChange = async (newVisibility: Audiences) => {
    setVisibility(newVisibility);
    setIsDropdownOpen(false);
    
    try {
      await updateDefaultAudience(newVisibility);
    } catch (error) {
      console.error('Failed to save visibility preference:', error);
    }
  };

  const handleSaveAnswer = async () => {
    if (!isAnswerValid() || !user || !question) return;

    setIsSaving(true);

    try {
      let answerTypeId: number = AnswerTypeId.TEXT;
      let displayValue: string;
      let answerData: AnswerData | undefined;

      if (question.type === 'mc' && answerValue !== null) {
        answerTypeId = AnswerTypeId.MC;
        displayValue = String(answerValue);
        const index = question.a_options?.indexOf(displayValue) ?? -1;
        answerData = { index };
      } else if (question.type === 'checkbox') {
        answerTypeId = AnswerTypeId.CHECKBOX;
        const checkboxValue = answerValue as CheckboxAnswerValue;
        displayValue = checkboxValue?.text || '';
        answerData = { indices: checkboxValue?.indices };
      } else if (question.type === 'scale' && typeof answerValue === 'number') {
        answerTypeId = AnswerTypeId.SCALE;
        // Store the raw numeric value; labels are computed at render time
        // from the question's scale_config (see src/lib/scale.ts).
        displayValue = String(answerValue);
        answerData = { index: answerValue };
      } else if (question.type === 'date') {
        answerTypeId = AnswerTypeId.DATE;
        const iso = (answerValue as AnswerData)?.iso ?? '';
        displayValue = iso;
        answerData = { iso };
      } else {
        displayValue = String(answerValue || '');
      }

      const token = getAuthToken();



      if (isUpdating && existingAnswerId && question.type !== 'mc') {
        const updatePayload = {
          value: displayValue,
          answer_type_id: answerTypeId,
          audience: visibility,
          ...(answerData && { answer_data: answerData }),
        };

        const response = await fetch(`/api/answers/${existingAnswerId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
          },
          body: JSON.stringify(updatePayload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to update answer: ${errorText}`);
        }

        await refetchAnswers();
        switchToAnswersList();
        showToast('Answer updated successfully!', 'success');
      } else {
        const answerPayload = {
          q_id: question.id,
          value: displayValue,
          answer_type_id: answerTypeId,
          audience: visibility,
          ...(answerData && { answer_data: answerData }),
          // Attribute to the wave in play; the server enforces its gate.
          ...(activePollId ? { poll_id: activePollId } : {}),
        };

        // Debug logging for answer save (temporary - remove after debugging)
        if (visibility === 'Anon') {
          console.log('[QuestionSlide] Saving ANON answer:', { answerPayload, userId: user?.fid });
        }

        let result;
        if (eligibility.worldGated && activePollId) {
          // Verified-human wave: the proof rides with the answer.
          const outcome = await worldAnswer.submit(answerPayload);
          if (outcome.kind === 'cancelled') {
            showToast('Not saved. You can verify with World ID any time before the wave closes.', 'info');
            return;
          }
          if (outcome.kind === 'error') throw new Error(outcome.message);
          result = outcome.result;
        } else {
          const response = await fetch('/api/answers', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token && { 'Authorization': `Bearer ${token}` })
            },
            body: JSON.stringify(answerPayload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('[QuestionSlide] Answer save failed:', errorText);
            throw new Error(`Failed to save answer: ${errorText}`);
          }

          result = await response.json();
        }
        
        // Debug logging for answer save result (temporary - remove after debugging)
        if (visibility === 'Anon') {
          console.log('[QuestionSlide] ANON answer saved, result:', result);
        }
        // Sticky audience: the server keeps a person's first public/anon choice
        // within a wave so a re-answer never links an anon vote to a name.
        if (result?.audience_kept && result.audience && result.audience !== visibility) {
          showToast(
            result.audience === 'Anon'
              ? 'Kept anonymous — your first answer here was anonymous'
              : 'Kept public — your first answer here was public',
            'info',
          );
        }

        await refetchAnswers();

        // MC results are rendered from a separate cached fetch; nudge it to refresh.
        if (question.type === 'mc') {
          setMcResultsVersion(v => v + 1);
        }

        if (!isUpdating) {
          setAnswerValue(null);
        }

        switchToAnswersList();
        showToast('Answer saved successfully!', 'success');
      }
    } catch (error) {
      console.error('Error saving answer:', error);
      alert(error instanceof Error ? error.message : 'Failed to save answer');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="question-slide">
      {/* Toast notifications */}
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          action={toast.action}
          onClose={() => removeToast(toast.id)}
        />
      ))}

      <div className={`question-slide-content ${viewMode === 'list' ? 'list-view' : ''}`}>
        <div className="question-text-container">
          <button 
            className="analytics-icon-btn"
            onClick={() => setShowAnalyticsModal(true)}
            title="View analytics"
          >
            <ChartColumn size={18} />
          </button>
          <h1 className="qp-question-text" style={{ whiteSpace: 'pre-wrap' }}>{displayStem}</h1>
          
          {showCastRetry && onRetryCast && (
            <button 
              className="retry-cast-btn"
              onClick={onRetryCast}
              disabled={isRetryingCast}
              title="Retry posting to Farcaster"
            >
              <RefreshCw size={14} className={isRetryingCast ? 'spin' : ''} />
              {isRetryingCast ? 'Posting...' : 'Retry Farcaster Post'}
            </button>
          )}
          {/* Snap cast: share question as Farcaster snap */}
          {showSnapCastButton && (
            <button
              className="snap-cast-btn"
              onClick={handleCastAsSnap}
              disabled={isCastingSnap}
              title="Share this question as a Farcaster Snap"
            >
              {isCastingSnap ? 'Sharing…' : snapCastDone ? '✅ Shared!' : '📊 Share as Snap'}
            </button>
          )}
          {snapCastError && <div className="snap-cast-error">{snapCastError}</div>}
        </div>

        <div className="qp-metadata">
          <span className="coined-by">
            coined by <Link to={`/ask/${question.coiner_fname || 'anonymous'}`}>@{question.coiner_fname || 'anonymous'}</Link>
            {question.forked_from && (
              <>
                {' · forked from '}
                <Link to={`/question/${question.forked_from}`} className="forked-from-link">
                  <GitFork size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                  {question.forked_from_coiner_fname ? `@${question.forked_from_coiner_fname}` : 'a question'}
                </Link>
              </>
            )}
          </span>
          <div className="qp-actions">
            <div className="qp-action-left">
              <button 
                className="icon-with-count clickable" 
                title="View answers"
                onClick={() => setViewMode('list')}
              >
                <MessageCircle size={18} />
                <span>{
                  (answersLoading || repliesLoading)
                    ? (question.pub_answers || 0)
                    : question.type === 'mc' || question.type === 'scale' || question.type === 'checkbox'
                      ? (answersTotal || 0)
                      : question.type === 'text'
                        ? (answersTotal || 0) + farcasterRepliesCount
                        : sortedResponses.length
                }</span>
              </button>
              <div className="icon-with-count" title="Private answers">
                <MessageCircleDashed size={18} />
                <span>{question.priv_answers || 0}</span>
              </div>
              <LikeButton
                questionId={question.id}
                initialLiked={question.user_has_liked || false}
                initialCount={displayLikes}
                showCount={true}
                size={18}
                className="icon-with-count"
                onError={handleLikeError}
              />
              <ShareButton
                url={`${window.location.origin}/${isSnapRenderable(question) ? 'snap/' : ''}question/${question.id}`}
                text={question.stem}
                size={18}
                className="icon-with-count"
              />
              <button
                className="icon-with-count clickable"
                title="Re-ask with a different answer shape"
                onClick={() => setForkPrefill({
                  forkedFrom: question.id,
                  sourceStem: question.stem,
                  stem: question.stem,
                  type: apiTypeToLocal(question.type),
                  options: question.a_options,
                  scaleConfig: question.scale_config,
                })}
              >
                <GitFork size={18} />
              </button>
            </div>
            <div className="qp-action-right">
              {question.casthash ? (
                isMiniApp ? (
                  <button
                    className="icon-btn"
                    title="View on Farcaster"
                    onClick={() => sdk.actions.viewCast({ hash: question.casthash })}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 22 20" fill="none">
                      <title>Farcaster logo</title>
                      <g fill="currentColor" clipPath="url(#a)">
                        <path d="M3.786.05h14.156v2.824h4.025l-.844 2.825h-.714v11.427c.358 0 .65.287.65.642v.77h.13c.358 0 .649.288.649.642v.77h-7.273v-.77c0-.354.29-.642.65-.642h.13v-.77c0-.309.22-.566.512-.628l-.014-6.306c-.23-2.519-2.37-4.493-4.98-4.493-2.608 0-4.75 1.974-4.979 4.494l-.013 6.3c.346.05.772.315.772.633v.77h.13c.358 0 .65.288.65.642v.77H.15v-.77c0-.354.29-.642.649-.642h.13v-.77c0-.355.29-.642.65-.642V5.7H.863L.02 2.874h3.766V.05Z"></path>
                      </g>
                      <defs>
                        <clipPath id="a">
                          <path fill="currentColor" d="M0 0h22v20H0z"></path>
                        </clipPath>
                      </defs>
                    </svg>
                  </button>
                ) : (
                  <a
                    href={`https://farcaster.xyz/~/conversations/${question.casthash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="icon-btn"
                    title="View on Farcaster"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="16" viewBox="0 0 22 20" fill="none">
                      <title>Farcaster logo</title>
                      <g fill="currentColor" clipPath="url(#a)">
                        <path d="M3.786.05h14.156v2.824h4.025l-.844 2.825h-.714v11.427c.358 0 .65.287.65.642v.77h.13c.358 0 .649.288.649.642v.77h-7.273v-.77c0-.354.29-.642.65-.642h.13v-.77c0-.309.22-.566.512-.628l-.014-6.306c-.23-2.519-2.37-4.493-4.98-4.493-2.608 0-4.75 1.974-4.979 4.494l-.013 6.3c.346.05.772.315.772.633v.77h.13c.358 0 .65.288.65.642v.77H.15v-.77c0-.354.29-.642.649-.642h.13v-.77c0-.355.29-.642.65-.642V5.7H.863L.02 2.874h3.766V.05Z"></path>
                      </g>
                      <defs>
                        <clipPath id="a">
                          <path fill="currentColor" d="M0 0h22v20H0z"></path>
                        </clipPath>
                      </defs>
                    </svg>
                  </a>
                )
              ) : castPending ? (
                <span className="icon-btn cast-pending-spinner" title="Posting to Farcaster...">
                  <LoadingAnimation variant="spinner" size="sm" />
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Answer Input View (default) */}
        {viewMode === 'answer' && (
          <div className="qp-answer-input-container">
            {/* Show notice if user already answered anonymously (even when isUpdating for non-anon) */}
            {hasOwnAnonAnswer && (
              <div className="existing-answer-notice anon-notice">
                <span className="notice-icon">🎭</span>
                <span className="notice-text">
                  You've already answered this anonymously.{' '}
                  <button 
                    className="notice-link"
                    onClick={() => setViewMode('list')}
                  >
                    View your answer
                  </button>
                </span>
              </div>
            )}
            {/* Show notice if user has non-anon answer but not in update mode */}
            {hasExistingAnswer && !isUpdating && !hasOwnAnonAnswer && (
              <div className="existing-answer-notice">
                <span className="notice-icon">ℹ️</span>
                <span className="notice-text">
                  You've already answered this question.{' '}
                  <button 
                    className="notice-link"
                    onClick={() => setViewMode('list')}
                  >
                    View your answer
                  </button>
                </span>
              </div>
            )}
            <WaveStrip question={question} />
            {worldAnswer.widget}
            {(!eligibility.canVote || eligibility.worldGated) && !eligibility.isLoading && (
              <PollLockBanner
                reason={eligibility.reason}
                question={question}
                closesAt={eligibility.closesAt}
              />
            )}
            <QuestionRenderer
              question={question}
              value={answerValue}
              onChange={setAnswerValue}
              disabled={!eligibility.canVote}
              audience={visibility === 'Anon' ? 'Anon' : 'Public'}
            />
            {/* Character count for text answers - only show when approaching limit (90%+) */}
            {question.type === 'text' && typeof answerValue === 'string' && answerValue.length > MAX_A_LENGTH * 0.9 && (
              <div 
                className="answer-char-count"
                style={{ 
                  textAlign: 'right', 
                  fontSize: '12px', 
                  marginTop: '4px',
                  color: answerValue.length > MAX_A_LENGTH ? '#ef4444' : '#f59e0b'
                }}
              >
                {answerValue.length.toLocaleString()}/{MAX_A_LENGTH.toLocaleString()}
                {answerValue.length > MAX_A_LENGTH && ' (exceeds limit)'}
              </div>
            )}
            
            <div className="qp-answer-footer">
              <div className="visibility-control" ref={visibilityControlRef} style={{ position: 'relative' }}>
                <div
                  className="visibility-trigger"
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                >
                  <Eye size={16} />
                  <span>{visibility === 'Private' ? 'Secret' : visibility}</span>
                  <ChevronDown size={14} />
                </div>

                {isDropdownOpen && (
                  <div className="visibility-dropdown">
                    <div onClick={() => handleVisibilityChange('Public')}>Public</div>
                    <div onClick={() => handleVisibilityChange('Anon')}>Anon</div>
                    <div
                      onClick={() => handleVisibilityChange('Private')}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}
                    >
                      <span>Secret</span>
                      <button
                        type="button"
                        aria-label="What does Secret mean?"
                        onClick={(e) => { e.stopPropagation(); setIsSecretInfoOpen(v => !v); }}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', color: 'inherit', opacity: 0.6 }}
                      >
                        <Info size={14} />
                      </button>
                    </div>
                  </div>
                )}

                {isSecretInfoOpen && (
                  <div
                    role="dialog"
                    aria-label="About Secret answers"
                    style={{
                      position: 'absolute',
                      bottom: 'calc(100% + 8px)',
                      left: 0,
                      width: 'min(340px, calc(100vw - 32px))',
                      padding: '14px 32px 14px 16px',
                      background: 'var(--color-surface, #1f2937)',
                      color: 'var(--color-text, #f3f4f6)',
                      border: '1px solid rgba(148, 163, 184, 0.25)',
                      borderRadius: '8px',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
                      zIndex: 20,
                    }}
                  >
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => setIsSecretInfoOpen(false)}
                      style={{ position: 'absolute', top: '6px', right: '8px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.6, fontSize: '14px', lineHeight: 1 }}
                    >
                      ×
                    </button>
                    <p style={{ margin: 0 }}>
                      Secret answers are between you and Q. They're stored on Quilibrium where Q can read them — but no other qbase users see them. Q uses what it learns from your Secrets to ask sharper follow-ups and build a fuller understanding of you. Private answers coming soon to web.
                    </p>
                  </div>
                )}
              </div>
              
              <button
                className={`save-answer-btn ${isAnswerValid() && eligibility.canVote ? 'active' : ''}`}
                disabled={!isAnswerValid() || isSaving || !eligibility.canVote}
                onClick={handleSaveAnswer}
              >
                {isSaving ? 'Saving...' : isUpdating ? 'Save new' : question.type === 'text' && (visibility === 'Public' || visibility === 'Anon') ? 'Cast' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* Answers List View */}
        {viewMode === 'list' && (
          <div className="qp-answers-container" ref={answersContainerRef}>
            {/* MC results — show for all snap-cast questions, highlight user's answer if they answered */}
            {isMcQuestion && isSnapCast && mcResults && (
              <div className="mc-results">
                <h3 className="mc-results__title">
                  Results {mcResults.total > 0 && `(${mcResults.total})`}
                </h3>
                <div className="mc-results__bars">
                  {mcResults.options.map((option, i) => {
                    const count = mcResults.counts[option] || 0;
                    const pct = mcResults.total > 0 ? Math.round((count / mcResults.total) * 100) : 0;
                    const isUserAnswer = mcResults.user_answer?.option_index === i;
                    return (
                      <div key={i} className={`mc-results__bar-row ${isUserAnswer ? 'mc-results__bar-row--answered' : ''}`}>
                        <div className="mc-results__bar-label">
                          {isUserAnswer && <span className="mc-results__answer-mark">✓ </span>}
                          {option}
                        </div>
                        <div className="mc-results__bar-track">
                          <div className="mc-results__bar-fill" style={{ width: `${pct}%` }} />
                          <span className="mc-results__bar-count">{count}</span>
                        </div>
                        <span className="mc-results__bar-pct">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="response-list">
              {/* Show spinner only when both are loading */}
              {answersLoading && repliesLoading && (
                <div className="responses-loading">
                  <LoadingAnimation variant="spinner" size="md" />
                </div>
              )}
              
              {/* Council thread — the models' answers + the summon button (docs/specs/paid-council.md) */}
              {!answersLoading && <CouncilPanel question={question} />}

              {/* Qbase human answers - shown first, animate in if replies loaded first */}
              {!answersLoading && humanAnswers.length > 0 && humanAnswers.map(response => {
                const rawValue = typeof response.value === 'string'
                  ? response.value
                  : JSON.stringify(response.value);
                const answerText = question.type === 'scale'
                  ? formatScaleAnswerValue(rawValue, question.scale_config)
                  : question.type === 'date'
                    ? formatDateAnswerValue(rawValue)
                    : rawValue;
                
                const isOwnAnswer = userAnswerData?.answer?.id === response.id ||
                  userAnswerData?.answers?.some((a: Answer) => a.id === response.id) ||
                  ('is_own_anon' in response && response.is_own_anon);
                const isAnonAnswer = 'audience' in response && response.audience === 'Anon';
                const isOwnAnon = 'is_own_anon' in response && response.is_own_anon;
                
                const authorName = isAnonAnswer
                  ? '4n0n'
                  : ('user_fname' in response && response.user_fname) 
                    ? (response.user_fname as string)
                    : '4n0n';
                
                const authorFid = isAnonAnswer ? undefined : ('user_fid' in response ? (response.user_fid as number) : undefined);
                const avatarUrl = isAnonAnswer ? undefined : ('user_pfp' in response ? (response.user_pfp as string) : undefined);
                const castHash = 'casthash' in response ? (response.casthash as string) : undefined;
                const likeCount = 'like_count' in response ? (response.like_count as number) : 0;
                const userHasLiked = 'user_has_liked' in response ? (response.user_has_liked as boolean) : false;
                
                return (
                  <CompactAnswerCard
                    key={response.id}
                    id={response.id}
                    answerText={answerText}
                    authorName={authorName}
                    authorFid={authorFid}
                    avatarUrl={avatarUrl}
                    isOwnAnswer={isOwnAnswer}
                    isAnonymous={isAnonAnswer || isOwnAnon || authorName === '4n0n'}
                    createdAt={response.created_at}
                    questionText={question.stem}
                    className="answer-slide-in"
                    castHash={castHash}
                    likeCount={likeCount}
                    userHasLiked={userHasLiked}
                  />
                );
              })}
              
              {/* See more link for recurring questions */}
              {userAnswerData && 
               (userAnswerData.primary_type === 'recurring' || userAnswerData.primary_type === 'prospective') && 
               userAnswerData.count !== undefined && userAnswerData.count > 1 && (
                <div className="see-more-answers">
                  <Link to={`/my-answers?q_id=${question.id}`}>
                    See {userAnswerData.count - 1} more of your answers
                  </Link>
                </div>
              )}
              
              {/* Farcaster Replies - shown after qbase answers */}
              {!repliesLoading && filteredFarcasterReplies.map((reply: FarcasterReply) => (
                <CompactAnswerCard
                  key={`fc-${reply.hash}`}
                  id={reply.hash}
                  answerText={reply.text}
                  authorName={reply.author.username}
                  authorFid={reply.author.fid}
                  avatarUrl={reply.author.pfp_url}
                  isOwnAnswer={reply.author.fid === user?.fid}
                  isAnonymous={false}
                  isFarcasterReply={true}
                  createdAt={new Date(reply.timestamp).getTime()}
                  questionText={question.stem}
                  onClick={() => {
                    window.open(
                      `https://farcaster.xyz/${reply.author.username}/${reply.hash.substring(0, 10)}`,
                      '_blank'
                    );
                  }}
                />
              ))}
              
              {/* Show "No responses" only when both have finished loading and both are empty */}
              {!answersLoading && !repliesLoading && 
               humanAnswers.length === 0 && filteredFarcasterReplies.length === 0 && (
                <div className="no-responses">No responses yet. Be the first to answer!</div>
              )}
              
              {/* Infinite scroll sentinel — triggers loading the next page when visible */}
              {hasNextPage && (
                <div ref={sentinelRef} style={{ height: 1 }}>
                  {isFetchingNextPage && (
                    <LoadingAnimation variant="spinner" size="sm" />
                  )}
                </div>
              )}

              {forks.length > 0 && (
                <div className="qp-variants">
                  <div className="qp-variants-header">
                    <GitFork size={14} /> Variants — {forks.length}
                  </div>
                  {forks.map(f => (
                    <Link key={f.id} to={`/question/${f.id}`} className="qp-variant-row">
                      <div className="qp-variant-stem">{f.stem}</div>
                      <div className="qp-variant-meta">
                        <span className="qp-variant-type">{f.type}</span>
                        {f.coiner_fname && (
                          <span className="qp-variant-author">@{f.coiner_fname}</span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Floating Action Button - only show in list view, rendered via portal to escape transform containment */}
      {isActive && viewMode === 'list' && createPortal(
        <button
          className="answer-fab"
          onClick={() => setViewMode('answer')}
          title="Add your answer"
        >
          🗣️
        </button>,
        document.body
      )}

      <QuestionAnalyticsModal
        isOpen={showAnalyticsModal}
        onClose={() => setShowAnalyticsModal(false)}
        question={question}
        answers={sortedResponses}
        farcasterReplies={filteredFarcasterReplies}
mcResults={mcResults}
      />

      <CreateQueryModal
        isOpen={forkPrefill !== null}
        onClose={() => setForkPrefill(null)}
        prefill={forkPrefill ?? undefined}
      />
    </div>
  );
};

export default QuestionSlide;

