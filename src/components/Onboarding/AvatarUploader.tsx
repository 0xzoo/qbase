/**
 * AvatarUploader
 *
 * Avatar upload component with preview, drag-and-drop, and client-side resize.
 * Used by OnboardingPage and profile edit flows.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, X, Camera } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { resizeImage } from '../../lib/imageProcessor';

interface AvatarUploaderProps {
  currentAvatarUrl: string | null;
  onUpload: (url: string) => void;
  onRemove: () => void;
  maxSizeMB?: number; // default 5MB
  showRemove?: boolean;
}

export const AvatarUploader: React.FC<AvatarUploaderProps> = ({
  currentAvatarUrl,
  onUpload,
  onRemove,
  maxSizeMB = 5,
  showRemove = true,
}) => {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(currentAvatarUrl);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync when parent passes new currentAvatarUrl
  useEffect(() => {
    if (currentAvatarUrl && !previewUrl) {
      setCurrentUrl(currentAvatarUrl);
    }
  }, [currentAvatarUrl, previewUrl]);

  const handleFile = useCallback(async (file: File) => {
    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setError('Only JPEG, PNG, or WebP images are allowed');
      return;
    }

    // Validate file size
    if (file.size > maxSizeMB * 1024 * 1024) {
      setError(`File must be under ${maxSizeMB}MB`);
      return;
    }

    setError(null);

    // Show preview immediately
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);

    // Upload
    setIsUploading(true);
    try {
      // Resize before upload
      const resizedBlob = await resizeImage(file, 512);
      const resizedFile = new File([resizedBlob], file.name, { type: 'image/jpeg' });

      const token = user?.sessionToken || user?.quickAuthToken;
      if (!token) {
        setError('Not authenticated');
        throw new Error('No auth token');
      }

      const formData = new FormData();
      formData.append('avatar', resizedFile);

      const res = await fetch('/api/users/avatar/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error || 'Upload failed');
      }

      const data = await res.json();
      setCurrentUrl(data.url);
      onUpload(data.url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      // Keep the preview URL so user sees what they tried to upload
    } finally {
      setIsUploading(false);
      // Clean up object URL
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    }
  }, [maxSizeMB, user, onUpload]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // Fallback avatar for display
  const displayAvatar = previewUrl || currentUrl;
  const isUploadingOrPreview = isUploading || (previewUrl && !currentUrl);

  return (
    <div className="avatar-uploader">
      {/* Avatar display */}
      <div className="avatar-display-wrapper">
        {displayAvatar ? (
          <div className="avatar-preview-container">
            <img
              src={displayAvatar.startsWith('/') ? displayAvatar : displayAvatar}
              alt="Avatar preview"
              className="avatar-preview"
            />
            {isUploading && (
              <div className="avatar-upload-overlay">
                <div className="avatar-spinner" />
              </div>
            )}
            {showRemove && !isUploading && (
              <button
                className="avatar-remove-btn"
                onClick={() => {
                  setPreviewUrl(null);
                  setCurrentUrl(null);
                  onRemove();
                }}
                aria-label="Remove avatar"
              >
                <X size={16} />
              </button>
            )}
          </div>
        ) : (
          <div
            className={`avatar-placeholder ${isDragging ? 'dragging' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <Camera size={32} strokeWidth={1.5} />
            <span>Upload avatar</span>
          </div>
        )}
      </div>

      {/* Upload controls */}
      <div className="avatar-controls">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileInputChange}
          className="hidden"
        />
        <button
          className="avatar-upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          <Upload size={16} />
          {isUploading ? 'Uploading...' : 'Choose image'}
        </button>
      </div>

      {error && (
        <p className="avatar-error">{error}</p>
      )}
    </div>
  );
};

export default AvatarUploader;
