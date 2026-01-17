import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Header from '../components/Header';
import QuestionCarousel from '../components/QuestionCarousel';
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
}

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as LocationState | null;
  const { invalidateAll } = useQuestionCacheUtils();
  
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
        // Navigate to the actual question URL with castPending flag
        navigate(`/question/${questionId}`, { 
          replace: true,
          state: { isNewQuestion: true, castPending: true }
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
          state: { isNewQuestion: true, castPending: true }
        });
      }
    });
    
    return () => clearInterval(interval);
  }, [pendingSubmission, navigate, invalidateAll]);
  
  // Track if we've already invalidated to prevent double-invalidation
  const hasInvalidatedRef = useRef(false);
  
  // Invalidate cache when this is a new question to ensure feed is fresh
  // Only run once per page load to prevent infinite API call loops
  useEffect(() => {
    if (locationState?.isNewQuestion && !hasInvalidatedRef.current) {
      hasInvalidatedRef.current = true;
      // Invalidate cache immediately so the new question appears in the feed
      console.log('[QuestionPage] New question detected, invalidating cache once');
      invalidateAll();
    }
  }, [locationState?.isNewQuestion, invalidateAll]);

  // Load all questions for the carousel (skip if we're polling for a pending question)
  // Sort by 'new' to ensure newly created questions appear at the top
  const { questions: allQuestions, loading: questionsLoading } = useQuestions({ 
    limit: 100,
    sort: 'new',
    enableInfiniteScroll: false
  });
  
  // Also load the specific question if navigating directly (for immediate display)
  const { question: directQuestion, loading: directLoading } = useQuestion(
    id === 'pending' ? undefined : id
  );

  // Handle question change in carousel (for analytics, etc.)
  const handleQuestionChange = useCallback((question: Query, index: number) => {
    // Could add analytics tracking here
    console.log('[Carousel] Now viewing:', question.stem.substring(0, 50), 'index:', index);
  }, []);

  // Check if this is an external entry (direct link to question)
  const isExternalEntry = location.key === 'default';

  // Show pending submission loading state
  if (pendingSubmission || id === 'pending') {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header
          showBack
          backLabel="Feed"
          onBack={() => navigate('/questions', { state: { fromQuestionCreation: locationState?.isNewQuestion } })}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '20px' }}>
          {pollingError ? (
            <>
              <div style={{ color: '#ff6b6b', textAlign: 'center' }}>{pollingError}</div>
              <button 
                onClick={() => navigate('/questions', { state: { fromQuestionCreation: locationState?.isNewQuestion } })}
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

  // Show loading state
  if (questionsLoading && !directQuestion) {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header
          showBack
          backLabel="Feed"
          onBack={() => navigate('/questions', { state: { fromQuestionCreation: locationState?.isNewQuestion } })}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <LoadingAnimation variant="spinner" size="lg" />
        </div>
      </div>
    );
  }

  // If we have a direct question but questions list is still loading,
  // show just that question in the carousel
  const questionsToShow = allQuestions.length > 0 
    ? allQuestions 
    : (directQuestion ? [directQuestion] : []);

  if (questionsToShow.length === 0) {
    return (
      <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header
          showBack
          backLabel="Feed"
          onBack={() => navigate('/questions', { state: { fromQuestionCreation: locationState?.isNewQuestion } })}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div>Question not found</div>
        </div>
      </div>
    );
  }

  return (
    <div className="question-page-wrapper" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        showBack
        backLabel={isExternalEntry ? 'Feed' : 'Back'}
        onBack={isExternalEntry ? () => navigate('/questions', { state: { fromQuestionCreation: locationState?.isNewQuestion } }) : undefined}
      />

      <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%', overflow: 'hidden' }}>
        <QuestionCarousel
          questions={questionsToShow}
          initialQuestionId={id}
          onQuestionChange={handleQuestionChange}
          castPendingQuestionId={locationState?.castPending ? id : undefined}
        />
      </div>
    </div>
  );
};

export default QuestionPage;
