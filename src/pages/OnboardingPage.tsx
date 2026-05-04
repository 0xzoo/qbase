/**
 * OnboardingPage
 *
 * Multi-step onboarding for users without a Farcaster pfp/username
 * already in place. Avatar is set from Farcaster on login, so the
 * remaining native fields here are username and bio.
 */

import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, SkipForward, CheckCircle, User, MessageSquare } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { UsernameInput } from '../components/Onboarding/UsernameInput';
import Header from '../components/Header';
import './OnboardingPage.css';

type Step = 'username' | 'bio' | 'complete';

const OnboardingPage: React.FC = () => {
  const { user, setUserData } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('username');
  const [chosenUsername, setChosenUsername] = useState('');
  const [bio, setBio] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Suggest username from FC or passkey data
  const suggestedUsername = user?.username || user?.displayName?.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 20) || '';

  const handleContinueAfterUsername = useCallback((username: string) => {
    setChosenUsername(username);
    setStep('bio');
  }, []);

  const handleSkip = useCallback(() => {
    if (step === 'username') {
      setStep('bio');
    } else if (step === 'bio') {
      setStep('complete');
    }
  }, [step]);

  const handleSaveAndContinue = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const token = user?.sessionToken || user?.quickAuthToken;
      if (!token) {
        console.error('[ONBOARDING] No auth token available');
        setIsSubmitting(false);
        return;
      }

      // Build profile updates (only include non-empty fields)
      const updates: Record<string, string> = {};
      if (chosenUsername) updates.username = chosenUsername;
      if (bio.trim()) updates.bio = bio.trim();

      if (Object.keys(updates).length > 0) {
        const res = await fetch('/api/users/profile', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(updates),
        });

        if (!res.ok) {
          const error = await res.json() as { error?: string };
          if (error.error === 'Username already taken') {
            alert('That username is already taken. Please choose another.');
            setStep('username');
            setIsSubmitting(false);
            return;
          }
          console.error('[ONBOARDING] Profile update failed:', error);
        } else {
          const data = await res.json();
          // Update local user state with saved profile
          if (data.user) {
            setUserData({
              username: data.user.username,
              displayName: data.user.display_name,
              bio: data.user.bio,
              profileSource: data.user.profile_source,
            });
          }
        }
      }

      // Mark onboarding as complete
      localStorage.setItem('onboarding_complete', 'true');

      setStep('complete');
    } catch (error) {
      console.error('[ONBOARDING] Save error:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [chosenUsername, bio, user, setUserData, isSubmitting]);

  const handleComplete = useCallback(() => {
    // Navigate to user's profile page using their chosen username
    const profilePath = chosenUsername ? `/ask/${chosenUsername}` : '/';
    navigate(profilePath, { replace: true });
  }, [navigate, chosenUsername]);

  const totalSteps = 2;
  const currentStepNum = step === 'username' ? 1 : step === 'bio' ? 2 : 3;

  return (
    <div className="onboarding-page min-h-screen w-full max-w-full overflow-y-auto">
      <Header showBack={false} />

      <div className="onboarding-container">
        {/* Progress indicator */}
        {step !== 'complete' && (
          <div className="onboarding-progress">
            <div className="onboarding-progress-bar">
              <div
                className="onboarding-progress-fill"
                style={{ width: `${(currentStepNum / totalSteps) * 100}%` }}
              />
            </div>
            <div className="onboarding-step-label">
              Step {currentStepNum} of {totalSteps}
            </div>
          </div>
        )}

        {/* Step 1: Username */}
        {step === 'username' && (
          <div className="onboarding-step">
            <div className="onboarding-step-icon">
              <User size={40} strokeWidth={1.5} />
            </div>
            <h1 className="onboarding-title">Choose your username</h1>
            <p className="onboarding-description">
              Pick a unique username for qbase. You can change it later.
            </p>

            <UsernameInput
              initialValue={chosenUsername || suggestedUsername}
              onChange={setChosenUsername}
              autoFocus
            />

            <div className="onboarding-actions">
              <button
                className="onboarding-skip-btn"
                onClick={handleSkip}
                disabled={isSubmitting}
              >
                <SkipForward size={16} />
                Skip for now
              </button>
              <button
                className="onboarding-continue-btn"
                onClick={handleContinueAfterUsername.bind(null, chosenUsername)}
                disabled={!chosenUsername || chosenUsername.length < 3 || isSubmitting}
              >
                Continue
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Bio */}
        {step === 'bio' && (
          <div className="onboarding-step">
            <div className="onboarding-step-icon">
              <MessageSquare size={40} strokeWidth={1.5} />
            </div>
            <h1 className="onboarding-title">Tell us about yourself</h1>
            <p className="onboarding-description">
              Add a short bio. This is optional — skip if you want.
            </p>

            <div className="onboarding-bio-input">
              <textarea
                className="onboarding-textarea"
                placeholder="A few words about you..."
                value={bio}
                onChange={(e) => {
                  if (e.target.value.length <= 280) {
                    setBio(e.target.value);
                  }
                }}
                maxLength={280}
                rows={4}
              />
              <div className="onboarding-char-count">{bio.length}/280</div>
            </div>

            <div className="onboarding-actions">
              <button
                className="onboarding-skip-btn"
                onClick={handleSkip}
                disabled={isSubmitting}
              >
                <SkipForward size={16} />
                Skip
              </button>
              <button
                className="onboarding-continue-btn"
                onClick={handleSaveAndContinue}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Saving...' : 'Save & Continue'}
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Complete */}
        {step === 'complete' && (
          <div className="onboarding-step">
            <div className="onboarding-complete-icon">
              <CheckCircle size={72} strokeWidth={1.5} />
            </div>
            <h1 className="onboarding-title">You're all set!</h1>
            <p className="onboarding-description">
              {chosenUsername ? (
                <>Welcome, <strong>@{chosenUsername}</strong>! Your profile is ready.</>
              ) : (
                <>Your profile is ready. You can always update it later.</>
              )}
            </p>
            <button
              className="onboarding-complete-btn"
              onClick={handleComplete}
            >
              Go to your profile
              <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default OnboardingPage;
