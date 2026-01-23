import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import QuestionCard from '../components/QuestionCard';
import CompactQuestionCard from '../components/CompactQuestionCard';
import AnswerCard from '../components/AnswerCard';
import { useQuestions } from '../hooks/useQuestions';
import { apiClient } from '../lib/apiClient';
import type { Query, AnswerWFname, Answer, TopicWithMetrics, TopicListResult } from '../lib/types';
import './FeedPage.css'; // Reusing FeedPage styles for consistency

// Extended answer type for the feed which includes the question stem
interface FeedAnswer extends Answer {
    question_stem?: string;
    user_fname?: string;
    user_fid?: number;
    like_count?: number;
    user_has_liked?: boolean;
}

const Home: React.FC = () => {
    const navigate = useNavigate();

    // Soothing color palette for word cloud
    const colors = [
        '#667eea', // Purple
        '#f093fb', // Pink
        '#4facfe', // Blue
        '#43e97b', // Green
        '#fa709a', // Coral
        '#a8edea', // Teal
        '#5ee7df', // Cyan
        '#ff9a9e', // Peach
        '#f5576c', // Red-coral
        '#38f9d7', // Turquoise
        '#764ba2', // Deep purple
        '#fee140', // Yellow
    ];

    // Section 1: Mindshare Map - Real topics from API
    const [topics, setTopics] = useState<TopicWithMetrics[]>([]);
    const [loadingTopics, setLoadingTopics] = useState(true);

    useEffect(() => {
        const fetchTopics = async () => {
            try {
                // Fetch top 8 trending topics
                const response = await apiClient.get('/api/topics?limit=8&offset=0&sortBy=momentum&timeWindow=7d');
                if (response.ok) {
                    const data = await response.json() as TopicListResult;
                    setTopics(data.topics);
                }
            } catch (error) {
                console.error('Failed to fetch topics:', error);
            } finally {
                setLoadingTopics(false);
            }
        };

        fetchTopics();
    }, []);

    // Calculate max question count for sizing
    const maxQuestionCount = useMemo(() => {
        if (topics.length === 0) return 1;
        return Math.max(...topics.map(t => t.total_questions || 1));
    }, [topics]);

    const handleTopicClick = (topic: TopicWithMetrics) => {
        navigate(`/topics/${encodeURIComponent(topic.name.toLowerCase())}`);
    };

    // Section 2: Top 3 Popular Questions
    const { questions: popularQuestions, loading: loadingQuestions } = useQuestions({
        sort: 'popular',
        limit: 3,
        enableInfiniteScroll: false
    });

    // Section 3: 3 Most Recent Answers
    const [recentAnswers, setRecentAnswers] = useState<FeedAnswer[]>([]);
    const [loadingAnswers, setLoadingAnswers] = useState(true);

    useEffect(() => {
        const fetchRecentAnswers = async () => {
            try {
                const response = await apiClient.get('/api/answers?limit=3&audience=Public,Anon');
                if (response.ok) {
                    const data = await response.json() as { results: FeedAnswer[] };
                    setRecentAnswers(data.results);
                }
            } catch (error) {
                console.error('Failed to fetch recent answers:', error);
            } finally {
                setLoadingAnswers(false);
            }
        };

        fetchRecentAnswers();
    }, []);

    return (
        <>
            <Header title="home" />
            <Sidebar />
            <div className="mobile-layout-container" style={{ paddingBottom: '80px' }}>

                {/* Section 1: Mindshare Map */}
                <div className="feed-section">
                    <div className="home-section-header">
                        <h2 className="home-section-title">trending topics</h2>
                        <button className="home-see-more" onClick={() => navigate('/topics')}>
                            see more →
                        </button>
                    </div>
                    <div className="mindshare-map">
                        {loadingTopics ? (
                            <div className="loading-spinner">Loading topics...</div>
                        ) : topics.length === 0 ? (
                            <div className="empty-state">No topics yet</div>
                        ) : (
                            topics.map((topic, index) => {
                                // Scale font size based on popularity (total_questions)
                                const popularity = topic.total_questions || 1;
                                const minSize = 1;
                                const maxSize = 3;
                                const fontSize = minSize + ((popularity / maxQuestionCount) * (maxSize - minSize));
                                
                                return (
                                    <span
                                        key={topic.id}
                                        className="topic-word"
                                        onClick={() => handleTopicClick(topic)}
                                        style={{
                                            color: colors[index % colors.length],
                                            fontSize: `${fontSize}rem`,
                                        }}
                                    >
                                        {topic.name}
                                    </span>
                                );
                            })
                        )}
                    </div>
                </div>

                <div className="section-divider" />

                {/* Section 2: Top 3 Recent Popular Questions */}
                <div className="feed-section">
                    <div className="home-section-header">
                        <h2 className="home-section-title">trending questions</h2>
                        <button className="home-see-more" onClick={() => navigate('/questions')}>
                            see more →
                        </button>
                    </div>
                    <div className="feed-content">
                        {loadingQuestions ? (
                            <div className="loading-spinner">Loading questions...</div>
                        ) : (
                            popularQuestions.map((q: Query) => (
                                <CompactQuestionCard
                                    key={q.id}
                                    id={q.id}
                                    questionText={q.stem}
                                    authorName={q.coiner_fname || 'anonymous'}
                                    authorFid={q.coiner_fid}
                                    showMatchBadge={false}
                                    transparent={true}
                                />
                            ))
                        )}
                    </div>
                </div>

                <div className="section-divider" />

                {/* Section 3: 3 Most Recent Answers */}
                <div className="feed-section">
                    <div className="home-section-header">
                        <h2 className="home-section-title">recent answers</h2>
                        <button className="home-see-more" onClick={() => navigate('/answers')}>
                            see more →
                        </button>
                    </div>
                    <div className="feed-content">
                        {loadingAnswers ? (
                            <div className="loading-spinner">Loading answers...</div>
                        ) : (
                            recentAnswers.map((a: FeedAnswer) => (
                                <AnswerCard
                                    key={a.id}
                                    answer={a}
                                    questionText={a.question_stem || "Question"}
                                    showActions={false}
                                />
                            ))
                        )}
                    </div>
                </div>

            </div>

            {/* Inline Styles for new Home-specific elements */}
            <style>{`
                .home-section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin: 0.5rem 1rem;
                }

                .home-section-title {
                    font-size: 1.25rem;
                    font-weight: 700;
                    color: var(--text-primary);
                    font-family: var(--font-display);
                    margin: 0;
                }

                .home-see-more {
                    background: none;
                    border: none;
                    color: var(--accent-color);
                    font-size: 0.875rem;
                    font-weight: 400;
                    cursor: pointer;
                    padding: 0.25rem 0.5rem;
                    transition: opacity 0.2s ease;
                }

                .home-see-more:hover {
                    opacity: 0.7;
                }
                
                .section-divider {
                    height: 1px;
                    background-color: var(--border-color);
                    margin: 1.5rem 0;
                    opacity: 0.5;
                }

                .mindshare-map {
                    display: flex;
                    flex-wrap: wrap;
                    gap: .5rem;
                    justify-content: center;
                    align-items: center;
                    min-height: 150px;
                    line-height: 1;
                }

                .topic-word {
                    font-weight: 700;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    display: inline-block;
                    font-family: var(--font-display);
                    user-select: none;
                    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
                }

                .topic-word:hover {
                    transform: scale(1.15);
                    opacity: 0.8;
                    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                }

                .empty-state {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    padding: 2rem;
                }

                /* Reuse feed styling */
                .feed-section .feed-content {
                    padding: 0; /* Remove extra padding if inherited */
                }
            `}</style>
        </>
    );
};

export default Home;
