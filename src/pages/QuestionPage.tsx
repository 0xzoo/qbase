import React, { useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Header from '../components/Header';
import QuestionCarousel from '../components/QuestionCarousel';
import LoadingAnimation from '../components/LoadingAnimation';
import { useQuestions, useQuestion } from '../hooks/useQuestions';
import type { Query } from '../lib/types';
import './QuestionPage.css';

const QuestionPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Load all questions for the carousel
  const { questions: allQuestions, loading: questionsLoading } = useQuestions({ limit: 100 });
  
  // Also load the specific question if navigating directly (for immediate display)
  const { question: directQuestion, loading: directLoading } = useQuestion(id);

  // Handle question change in carousel (for analytics, etc.)
  const handleQuestionChange = useCallback((question: Query, index: number) => {
    // Could add analytics tracking here
    console.log('[Carousel] Now viewing:', question.stem.substring(0, 50), 'index:', index);
  }, []);

  // Check if this is an external entry (direct link to question)
  const isExternalEntry = location.key === 'default';

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
    </div>
  );
};

export default QuestionPage;
