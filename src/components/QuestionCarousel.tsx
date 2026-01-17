import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import QuestionSlide from './QuestionSlide';
import type { Query } from '../lib/types';
import './QuestionCarousel.css';

interface QuestionCarouselProps {
  questions: Query[];
  initialQuestionId?: string;
  onQuestionChange?: (question: Query, index: number) => void;
  castPendingQuestionId?: string;
}

const QuestionCarousel: React.FC<QuestionCarouselProps> = ({
  questions,
  initialQuestionId,
  onQuestionChange,
  castPendingQuestionId,
}) => {
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastDragRef = useRef<{ x: number; time: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(400);
  
  // Find initial index based on URL parameter
  const initialIndex = useMemo(() => {
    if (!initialQuestionId) return 0;
    const idx = questions.findIndex(q => q.id === initialQuestionId);
    return idx >= 0 ? idx : 0;
  }, [questions, initialQuestionId]);

  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0); // In pixels, not percentage
  const [isAnimating, setIsAnimating] = useState(false);

  // Track container width for accurate drag calculations
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };
    
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Sync activeIndex when initialQuestionId changes (e.g., from URL navigation)
  useEffect(() => {
    if (initialQuestionId) {
      const newIndex = questions.findIndex(q => q.id === initialQuestionId);
      if (newIndex >= 0 && newIndex !== activeIndex) {
        setActiveIndex(newIndex);
      }
    }
  }, [initialQuestionId, questions]);

  // Update URL when activeIndex changes (without navigation)
  // BUT don't update if we're waiting to find the initialQuestionId in the questions array
  useEffect(() => {
    const currentQuestion = questions[activeIndex];
    if (currentQuestion) {
      // If we have an initialQuestionId that doesn't match the current question,
      // and that question isn't in the array yet, don't update the URL
      // This prevents overwriting the URL with stale data during cache refresh
      if (initialQuestionId && currentQuestion.id !== initialQuestionId) {
        const targetIndex = questions.findIndex(q => q.id === initialQuestionId);
        if (targetIndex === -1) {
          // Target question not in array yet - waiting for fresh data, don't update URL
          return;
        }
      }
      
      // Update URL without triggering navigation
      const newUrl = `/question/${currentQuestion.id}`;
      if (location.pathname !== newUrl) {
        window.history.replaceState(null, '', newUrl);
      }
      
      // Notify parent
      onQuestionChange?.(currentQuestion, activeIndex);
    }
  }, [activeIndex, questions, location.pathname, onQuestionChange, initialQuestionId]);

  const goToIndex = useCallback((newIndex: number, animated = true) => {
    if (newIndex < 0 || newIndex >= questions.length) return;
    if (newIndex === activeIndex) return;
    
    if (animated) {
      setIsAnimating(true);
      setTimeout(() => setIsAnimating(false), 350);
    }
    
    setActiveIndex(newIndex);
    setDragOffset(0);
  }, [activeIndex, questions.length]);

  const goToNext = useCallback(() => {
    goToIndex(activeIndex + 1);
  }, [activeIndex, goToIndex]);

  const goToPrev = useCallback(() => {
    goToIndex(activeIndex - 1);
  }, [activeIndex, goToIndex]);

  // Snap back with spring animation
  const snapBack = useCallback(() => {
    setIsAnimating(true);
    setDragOffset(0);
    setTimeout(() => setIsAnimating(false), 350);
  }, []);

  // Calculate velocity for momentum-based swiping
  const getVelocity = useCallback(() => {
    if (!dragStartRef.current || !lastDragRef.current) return 0;
    const deltaTime = lastDragRef.current.time - dragStartRef.current.time;
    if (deltaTime === 0) return 0;
    const deltaX = lastDragRef.current.x - dragStartRef.current.x;
    return deltaX / deltaTime; // pixels per ms
  }, []);

  // Touch/Mouse event handlers for direct manipulation
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    dragStartRef.current = { x: clientX, y: clientY, time: Date.now() };
    lastDragRef.current = { x: clientX, time: Date.now() };
    setIsDragging(true);
    setIsAnimating(false);
  }, []);

  const handleDragMove = useCallback((clientX: number, clientY: number) => {
    if (!dragStartRef.current || !isDragging) return;
    
    const deltaX = clientX - dragStartRef.current.x;
    const deltaY = clientY - dragStartRef.current.y;
    
    // If vertical movement dominates, don't interfere with scroll
    if (Math.abs(deltaY) > Math.abs(deltaX) * 1.5 && Math.abs(deltaX) < 20) {
      return;
    }
    
    // Track for velocity calculation
    lastDragRef.current = { x: clientX, time: Date.now() };
    
    // Apply resistance at edges (can't swipe past first/last)
    let offset = deltaX;
    const maxOffset = containerWidth * 0.4; // Max 40% of screen width
    
    if ((activeIndex === 0 && offset > 0) || 
        (activeIndex === questions.length - 1 && offset < 0)) {
      // Rubber band effect at edges - logarithmic resistance
      const sign = offset > 0 ? 1 : -1;
      const absOffset = Math.abs(offset);
      offset = sign * Math.log(1 + absOffset * 0.1) * 30;
    } else {
      // Normal drag with slight friction for stickiness
      offset = offset * 0.92;
    }
    
    // Clamp to max offset
    offset = Math.max(-maxOffset, Math.min(maxOffset, offset));
    
    setDragOffset(offset);
  }, [isDragging, activeIndex, questions.length, containerWidth]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    
    setIsDragging(false);
    
    const velocity = getVelocity(); // pixels per ms
    const dragPercentage = Math.abs(dragOffset) / containerWidth;
    
    // Thresholds for completing swipe
    const velocityThreshold = 0.4; // Fast swipe threshold (px/ms)
    const distanceThreshold = 0.25; // 25% of screen width
    
    const isFastSwipe = Math.abs(velocity) > velocityThreshold;
    const isLongDrag = dragPercentage > distanceThreshold;
    
    // Determine direction
    const isSwipingLeft = dragOffset < 0;
    const isSwipingRight = dragOffset > 0;
    
    if ((isFastSwipe || isLongDrag) && isSwipingLeft && activeIndex < questions.length - 1) {
      goToNext();
    } else if ((isFastSwipe || isLongDrag) && isSwipingRight && activeIndex > 0) {
      goToPrev();
    } else {
      // Spring back
      snapBack();
    }
    
    dragStartRef.current = null;
    lastDragRef.current = null;
  }, [isDragging, dragOffset, getVelocity, activeIndex, questions.length, goToNext, goToPrev, snapBack, containerWidth]);

  // Check if event target is inside the answers container (non-swipeable area)
  const isInAnswersContainer = useCallback((target: EventTarget | null): boolean => {
    if (!target || !(target instanceof Element)) return false;
    return target.closest('.qp-answers-container') !== null;
  }, []);

  // Touch handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Don't start swipe if touching the answers container
    if (isInAnswersContainer(e.target)) return;
    
    const touch = e.touches[0];
    handleDragStart(touch.clientX, touch.clientY);
  }, [handleDragStart, isInAnswersContainer]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    handleDragMove(touch.clientX, touch.clientY);
  }, [handleDragMove]);

  const handleTouchEnd = useCallback(() => {
    handleDragEnd();
  }, [handleDragEnd]);

  // Mouse handlers (for desktop testing)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Don't start swipe if clicking the answers container
    if (isInAnswersContainer(e.target)) return;
    
    e.preventDefault();
    handleDragStart(e.clientX, e.clientY);
  }, [handleDragStart, isInAnswersContainer]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    handleDragMove(e.clientX, e.clientY);
  }, [isDragging, handleDragMove]);

  const handleMouseUp = useCallback(() => {
    handleDragEnd();
  }, [handleDragEnd]);

  const handleMouseLeave = useCallback(() => {
    if (isDragging) {
      handleDragEnd();
    }
  }, [isDragging, handleDragEnd]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        goToNext();
      } else if (e.key === 'ArrowLeft') {
        goToPrev();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToNext, goToPrev]);

  // Calculate which slides to render (virtualization for performance)
  const visibleRange = useMemo(() => {
    const buffer = 2; // Render 2 slides on each side
    return {
      start: Math.max(0, activeIndex - buffer),
      end: Math.min(questions.length - 1, activeIndex + buffer),
    };
  }, [activeIndex, questions.length]);

  // Calculate transform for smooth sliding
  // Base offset as percentage, drag offset converted from pixels to percentage
  const trackTransform = useMemo(() => {
    const baseOffsetPercent = -activeIndex * 100;
    const dragOffsetPercent = (dragOffset / containerWidth) * 100;
    return `translateX(${baseOffsetPercent + dragOffsetPercent}%)`;
  }, [activeIndex, dragOffset, containerWidth]);

  if (questions.length === 0) {
    return <div className="carousel-empty">No questions available</div>;
  }

  const currentQuestion = questions[activeIndex];
  const canGoPrev = activeIndex > 0;
  const canGoNext = activeIndex < questions.length - 1;

  return (
    <div 
      className="question-carousel" 
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      {/* Progress indicator */}
      {/* <div className="carousel-progress">
        <div 
          className="carousel-progress-bar" 
          style={{ width: `${((activeIndex + 1) / questions.length) * 100}%` }}
        />
      </div> */}

      {/* Slide track */}
      <div 
        className={`carousel-track ${isDragging ? 'dragging' : ''} ${isAnimating ? 'animating' : ''}`}
        style={{ transform: trackTransform }}
      >
        {questions.map((question, index) => {
          // Only render slides within visible range
          const isInRange = index >= visibleRange.start && index <= visibleRange.end;
          const isActive = index === activeIndex;

          return (
            <div 
              key={question.id} 
              className={`carousel-slide ${isActive ? 'active' : ''}`}
              aria-hidden={!isActive}
            >
              {isInRange ? (
                <QuestionSlide
                  question={question}
                  isActive={isActive}
                  isCastPending={question.id === castPendingQuestionId}
                />
              ) : (
                <div className="slide-placeholder" />
              )}
            </div>
          );
        })}
      </div>

      {/* Navigation buttons */}
      <div className="carousel-nav">
        <button 
          className={`carousel-nav-btn prev ${!canGoPrev ? 'disabled' : ''}`}
          onClick={goToPrev}
          disabled={!canGoPrev}
          aria-label="Previous question"
        >
          <ChevronLeft size={24} />
        </button>
        
        <div className="carousel-counter">
          {activeIndex + 1} / {questions.length}
        </div>
        
        <button 
          className={`carousel-nav-btn next ${!canGoNext ? 'disabled' : ''}`}
          onClick={goToNext}
          disabled={!canGoNext}
          aria-label="Next question"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    </div>
  );
};

export default QuestionCarousel;

