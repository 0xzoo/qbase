import React from 'react';
import PollCreationForm from '../components/poll/PollCreationForm';
import './PollCreationPage.css';

const PollCreationPage: React.FC = () => {
  return (
    <div className="poll-creation-page">
      <PollCreationForm navigateOnSuccess={true} />
    </div>
  );
};

export default PollCreationPage;
