import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import PollCreationForm, { type ExistingQuestion } from '../components/poll/PollCreationForm';
import LoadingAnimation from '../components/LoadingAnimation';
import './PollCreationPage.css';

/**
 * /create-poll               — create an mc question and its first wave
 * /create-poll?question=<id> — re-ask: open a new wave on an existing question
 */
const PollCreationPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const questionId = searchParams.get('question');
  const [existing, setExisting] = useState<ExistingQuestion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!questionId) return;
    let cancelled = false;
    fetch(`/api/queries/${questionId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Question not found' : 'Could not load that question');
        return res.json() as Promise<{ id: string; stem: string; type: string; a_options?: string[] }>;
      })
      .then((q) => {
        if (cancelled) return;
        if (q.type !== 'mc') throw new Error('Only multiple-choice questions can be asked again as a poll for now');
        setExisting({ id: q.id, stem: q.stem, type: q.type, a_options: q.a_options });
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [questionId]);

  const loading = !!questionId && !existing && !loadError;

  return (
    <div className="poll-creation-page-wrapper">
      <Header showBack backLabel="Back" title={questionId ? 'New Poll' : 'Create Poll'} />
      <Sidebar />
      <div className="mobile-layout-container poll-creation-container">
        <div className="poll-creation-page">
          {loading && <LoadingAnimation variant="spinner" size="lg" />}
          {loadError && <div className="poll-form__error">{loadError}</div>}
          {!loading && !loadError && (
            <PollCreationForm navigateOnSuccess={true} existingQuestion={existing ?? undefined} />
          )}
        </div>
      </div>
    </div>
  );
};

export default PollCreationPage;
