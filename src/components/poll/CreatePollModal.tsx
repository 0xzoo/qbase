import React from 'react';
import PollCreationForm from './PollCreationForm';
import './CreatePollModal.css';

interface CreatePollModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CreatePollModal: React.FC<CreatePollModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="create-poll-modal__overlay" onClick={onClose}>
      <div className="create-poll-modal__content" onClick={e => e.stopPropagation()}>
        <PollCreationForm
          navigateOnSuccess={true}
          onCancel={onClose}
        />
      </div>
    </div>
  );
};

export default CreatePollModal;
