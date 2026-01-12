import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Header from '../components/Header';
import QuestionCarousel from '../components/QuestionCarousel';
import LoadingAnimation from '../components/LoadingAnimation';
import Toast from '../components/Toast';
import { useQuestions, useQuestion } from '../hooks/useQuestions';
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
  
  // Pending submission polling state
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(
    locationState?.pendingSubmission || null
  );
  const [pollingError, setPollingError] = useState<string | null>(null);
  const [foundQuestionId, setFoundQuestionId] = useState<string | null>(null);
  const pollCountRef = useRef(0);
  
  // Toast state for cast pending notification
  const [showCastPendingToast, setShowCastPendingToast] = useState(false);
  
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
        setFoundQuestionId(questionId);
        setPendingSubmission(null);
        setShowCastPendingToast(true);
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
    pollForQuestion().then(questionId => {
      if (questionId) {
        clearInterval(interval);
        setFoundQuestionId(questionId);
        setPendingSubmission(null);
        setShowCastPendingToast(true);
        navigate(`/question/${questionId}`, { 
          replace: true,
          state: { isNewQuestion: true }
        });
      }
    });
    
    return () => clearInterval(interval);
  }, [pendingSubmission, navigate]);
  
  // Show toast when navigating here with castPending flag
  useEffect(() => {
    if (locationState?.castPending) {
      setShowCastPendingToast(true);
      // Clear the state so it doesn't show again on refresh
      window.history.replaceState({}, document.title);
    }
  }, [locationState?.castPending]);

  // Load all questions for the carousel (skip if we're polling for a pending question)
  const { questions: allQuestions, loading: questionsLoading } = useQuestions({ 
    limit: 100,
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
          onBack={() => navigate('/questions')}
        />
        <div className="question-page mobile-layout-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '20px' }}>
          {pollingError ? (
            <>
              <div style={{ color: '#ff6b6b', textAlign: 'center' }}>{pollingError}</div>
              <button 
                onClick={() => navigate('/questions')}
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
          onBack={() => navigate('/questions')}
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
          onBack={() => navigate('/questions')}
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
        onBack={isExternalEntry ? () => navigate('/questions') : undefined}
      />

      <div className="question-page mobile-layout-container" style={{ flex: 1, width: '100%', overflow: 'hidden' }}>
        <QuestionCarousel
          questions={questionsToShow}
          initialQuestionId={id}
          onQuestionChange={handleQuestionChange}
        />
      </div>
      
      {/* Toast for cast pending notification */}
      {showCastPendingToast && (
        <Toast
          message="Question created! Farcaster cast is still posting..."
          type="info"
          duration={8000}
          onClose={() => setShowCastPendingToast(false)}
        />
      )}
    </div>
  );
};

export default QuestionPage;
