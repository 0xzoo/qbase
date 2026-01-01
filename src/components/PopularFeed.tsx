import React, { useRef, useEffect } from 'react';
import QuestionList from './QuestionList';
import { useQuestions } from '../hooks/useQuestions';

const PopularFeed: React.FC = () => {
  // For now, we'll use the same endpoint but could add sorting by popularity later
  const { questions, loading, loadingMore, error, hasMore, loadMore } = useQuestions({ 
    sort: 'popular',
    enableInfiniteScroll: true,
    limit: 20
  });
  
  // Intersection Observer for infinite scroll
  const observerTarget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    const currentTarget = observerTarget.current;
    if (currentTarget) {
      observer.observe(currentTarget);
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget);
      }
    };
  }, [hasMore, loadingMore, loadMore]);

  if (loading) {
    return <div className="loading-spinner">Loading...</div>;
  }

  if (error) {
    return <div className="error-message">Error: {error}</div>;
  }

  return (
    <>
      <QuestionList questions={questions} />
      {loadingMore && (
        <div className="loading-spinner" style={{ padding: '20px', textAlign: 'center' }}>
          Loading more...
        </div>
      )}
      {hasMore && !loadingMore && <div ref={observerTarget} style={{ height: '20px' }} />}
      {!hasMore && <div style={{ height: '60px' }} />}
    </>
  );
};

export default PopularFeed;
