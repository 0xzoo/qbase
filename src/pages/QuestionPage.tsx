import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Header from '../components/Header';
import QuestionCarousel from '../components/QuestionCarousel';
import QuestionSlide from '../components/QuestionSlide';
import LoadingAnimation from '../components/LoadingAnimation';
import { useQuestions, useQuestion, useQuestionCacheUtils } from '../hooks/useQuestions';
import type { Query } from '../lib/types';
import './QuestionPage.css';

interface PendingSubmission {
  stem: string;
  fid: number;
  token: string;
}

interface LocationState {
  isNewQuestion?: boolean;
  castPending?: boolean;
  pendingSubmission?: PendingSubmission;
  useCarousel?: boolean; // If true, show carousel with all questions instead of single view
}

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // ?poll=<id> answers through that wave instead of the open one.
  const activePollParam = new URLSearchParams(location.search).get('poll') ?? undefined;
  const locationState = location.state as LocationState | null;
  const { invalidateAll } = useQuestionCacheUtils();
  
  // Determine view mode:
  // - Single question view: DEFAULT - for new questions, direct links, profile navigation, etc.
  // - Carousel view: ONLY when explicitly requested via state (e.g., navigating from feed)
  // This prevents loading 100 questions when we only need to show one
  const isNewQuestion = locationState?.isNewQuestion === true;
  const useCarousel = locationState?.useCarousel === true;
  const isSingleQuestionView = !useCarousel; // Default to single view unless carousel explicitly requested
  
  // Pending submission polling state
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(
    locationState?.pendingSubmission || null
  );
  const [pollingError, setPollingError] = useState<string | null>(null);
  const pollCountRef = useRef(0);
  
  
  // Poll for the pending question
  useEffect(() => {
    if (!pendingSubmission) return;
    
    console.log('[QuestionPage] Starting poll for pending question:', pendingSubmission.stem.substring(0, 30));
    
    const pollForQuestion = async (): Promise<string | null> => {
      try {
        const response = await fetch(`/api/queries?coiner_fid=${pendingSubmission.fid}&limit=5`, {
          headers: { 'Authorization': `Bearer ${pendingSubmission.token}` }
        });
        if (response.ok) {
          const data = await response.json();
          const match = data.results?.find((q: { stem: string }) => 
            q.stem.toLowerCase().trim() === pendingSubmission.stem.toLowerCase().trim()
          );
          if (match) {
            return match.id;
          }
        }
      } catch (e) {
        console.error('[QuestionPage] Poll error:', e);
      }
      return null;
    };
    
    const interval = setInterval(async () => {
      pollCountRef.current += 1;
      console.log('[QuestionPage] Polling attempt', pollCountRef.current);
      
      const questionId = await pollForQuestion();
      if (questionId) {
        console.log('[QuestionPage] Found question:', questionId);
        clearInterval(interval);
        setPendingSubmission(null);
        // Invalidate cache to ensure new question appears in lists
        await invalidateAll();
        // Navigate to the actual question URL
        navigate(`/question/${questionId}`, { 
          replace: true,
          state: { isNewQuestion: true }
        });
      } else if (pollCountRef.current >= 20) {
        // Stop after ~60 seconds (20 polls * 3s)
        console.log('[QuestionPage] Max poll attempts reached');
        clearInterval(interval);
        setPollingError('Question creation is taking longer than expected. Check your questions in your profile or try again.');
        setPendingSubmission(null);
      }
    }, 3000);
    
    // Initial poll immediately
    pollForQuestion().then(async (questionId) => {
      if (questionId) {
        clearInterval(interval);
        setPendingSubmission(null);
        // Invalidate cache to ensure new question appears in lists
        await invalidateAll();
        navigate(`/question/${questionId}`, { 
          replace: true,
          state: { isNewQuestion: true }
        });
      }
    });
    
    return () => clearInterval(interval);
  }, [pendingSubmission, navigate, invalidateAll]);
  
  // Track which question ID we've invalidated for to prevent double-invalidation
  const lastInvalidatedIdRef = useRef<string | null>(null);
  
  // Invalidate cache when this is a new question to ensure feed is fresh when they go back
  useEffect(() => {
    if (isNewQuestion && id && lastInvalidatedIdRef.current !== id) {
      lastInvalidatedIdRef.current = id;
      console.log('[QuestionPage] New question detected, invalidating cache for:', id);
      invalidateAll();
    }
  }, [isNewQuestion, id, invalidateAll]);

  // Load all questions for carousel mode only (skip for single question view to avoid unnecessary API calls)
  const shouldLoadCarousel = !isSingleQuestionView && !pendingSubmission && id !== 'pending';
  const { questions: allQuestions, loading: questionsLoading } = useQuestions({ 
    limit: 100,
    sort: 'new',
    enableInfiniteScroll: false,
    enabled: shouldLoadCarousel, // Skip API call entirely when not needed
  });
  
  // Always load the specific question for single view or immediate display
  const { question: directQuestion, loading: directLoading } = useQuestion(
    id === 'pending' ? undefined : id,
    activePollParam,
  );

  // Handle question change in carousel (for analytics, etc.)
  const handleQuestionChange = useCallback((question: Query, index: number) => {
    console.log('[Carousel] Now viewing:', question.stem.substring(0, 50), 'index:', index);
  }, []);

  // Show pending submission loading state
  if (pendingSubmission || id === 'pending') {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header
          showBack
          backLabel="Feed"
          onBack={() => navigate('/questions', { state: { fromQuestionCreation: isNewQuestion } })}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '20px' }}>
          {pollingError ? (
            <>
              <div style={{ color: '#ff6b6b', textAlign: 'center' }}>{pollingError}</div>
              <button 
                onClick={() => navigate('/questions', { state: { fromQuestionCreation: isNewQuestion } })}
                style={{ 
                  padding: '10px 20px', 
                  background: 'var(--color-primary)', 
                  color: 'white', 
                  border: 'none', 
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Go to Feed
              </button>
            </>
          ) : (
            <>
              <LoadingAnimation variant="spinner" size="lg" />
              <div style={{ textAlign: 'center', opacity: 0.8 }}>
                <div style={{ fontWeight: 500, marginBottom: '8px' }}>Creating your question...</div>
                <div style={{ fontSize: '14px', opacity: 0.7 }}>Posting to Farcaster</div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // SINGLE QUESTION VIEW: For new questions, direct links, etc.
  // Shows just the one question without carousel navigation
  if (isSingleQuestionView) {
    if (directLoading) {
      return (
        <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          <Header
            showBack
            backLabel="Feed"
            onBack={() => navigate('/questions', { state: { fromQuestionCreation: isNewQuestion } })}
          />
          <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LoadingAnimation variant="spinner" size="lg" />
          </div>
        </div>
      );
    }

    if (!directQuestion) {
      return (
        <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          <Header
            showBack
            backLabel="Feed"
            onBack={() => navigate('/questions', { state: { fromQuestionCreation: isNewQuestion } })}
          />
          <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div>Question not found</div>
          </div>
        </div>
      );
    }

    // Render single question without carousel wrapper
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header
          showBack
          backLabel="Feed"
          onBack={() => navigate('/questions', { state: { fromQuestionCreation: isNewQuestion } })}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%', overflow: 'auto' }}>
          <QuestionSlide
            question={directQuestion}
            isActive={true}
            isCastPending={locationState?.castPending}
          />
        </div>
      </div>
    );
  }

  // CAROUSEL VIEW: When navigating from feed
  // Show loading state
  if (questionsLoading && !directQuestion) {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header showBack backLabel="Back" />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <LoadingAnimation variant="spinner" size="lg" />
        </div>
      </div>
    );
  }

  // Use all questions for carousel, but ONLY if the target question is in the set.
  // The feed may have scrolled beyond what the carousel's limit:100 fetch returns.
  const targetInAllQuestions = id ? allQuestions.some(q => q.id === id) : false;
  const questionsToShow = (allQuestions.length > 0 && targetInAllQuestions)
    ? allQuestions 
    : (directQuestion ? [directQuestion] : []);

  // If carousel loaded but target question isn't in it, fall back to single view
  if (!questionsLoading && allQuestions.length > 0 && !targetInAllQuestions && directQuestion) {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header
          showBack
          backLabel="Feed"
          onBack={() => navigate('/questions', { state: { fromQuestionCreation: isNewQuestion } })}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%', overflow: 'auto' }}>
          <QuestionSlide
            question={directQuestion}
            isActive={true}
          />
        </div>
      </div>
    );
  }

  if (questionsToShow.length === 0) {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header showBack backLabel="Back" />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div>Question not found</div>
        </div>
      </div>
    );
  }

  return (
    <div className="question-page-wrapper" style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <Header showBack backLabel="Back" />

      <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%', overflow: 'hidden', minHeight: 0 }}>
        <QuestionCarousel
          questions={questionsToShow}
          initialQuestionId={id}
          onQuestionChange={handleQuestionChange}
        />
      </div>
    </div>
  );
};

export default QuestionPage;
