-- Migration: Rename Users table to AlphaUsers and create new Users table
-- This migration preserves the existing Users data in AlphaUsers and creates a fresh Users table

-- Step 1: Rename the existing Users table to AlphaUsers
ALTER TABLE Users RENAME TO AlphaUsers;

-- Step 2: Create a new Users table with the same schema
CREATE TABLE Users (
  id INTEGER PRIMARY KEY, 
  fname TEXT, 
  fid NUMBER, 
  points_balance NUMBER NOT NULL, 
  points_allowance NUMBER NOT NULL, 
  created_at NUMBER DEFAULT CURRENT_TIMESTAMP, 
  primary_address TEXT, 
  q_cost NUMBER DEFAULT 3, 
  socials TEXT
);

