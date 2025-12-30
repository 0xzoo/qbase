/**
 * Test script for user creation flow
 * 
 * Tests:
 * 1. User creation via UserService
 * 2. User upsert (update existing)
 * 3. User lookup by FID
 * 4. Auto-creation middleware
 */

import { UserService } from '../worker/services/UserService';
import { ensureUserExists } from '../worker/middleware/userAutoCreate';

// Mock environment for testing
const mockEnv = {
  DB: {
    prepare: (query: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          console.log('Mock DB query:', query);
          console.log('Mock DB params:', args);
          
          // Simulate user doesn't exist
          if (query.includes('SELECT') && query.includes('WHERE fid = ?')) {
            return null;
          }
          
          // Simulate user creation
          if (query.includes('INSERT INTO users')) {
            return {
              id: 1,
              fid: args[1],
              fname: args[0],
              points_balance: args[2],
              points_allowance: args[3],
              created_at: args[4],
              primary_address: args[5],
              q_cost: args[6],
              socials: args[7],
            };
          }
          
          return null;
        },
        run: async () => {
          console.log('Mock DB run:', query);
          return { success: true };
        },
      }),
    }),
  },
  NEYNAR_API_KEY: 'mock-key',
};

async function testUserCreation() {
  console.log('🧪 Testing User Creation Flow\n');
  
  // Test 1: Create new user
  console.log('Test 1: Create new user');
  console.log('========================');
  try {
    const user = await UserService.upsert(mockEnv as any, {
      fid: 12345,
      fname: 'testuser',
      displayName: 'Test User',
      pfpUrl: 'https://example.com/avatar.png',
    });
    
    console.log('✅ User created:', user);
    console.log('- ID:', user.id);
    console.log('- FID:', user.fid);
    console.log('- Username:', user.fname);
    console.log('- Points:', user.points_balance);
  } catch (error) {
    console.error('❌ Test 1 failed:', error);
  }
  
  console.log('\n');
  
  // Test 2: Lookup user by FID
  console.log('Test 2: Lookup user by FID');
  console.log('===========================');
  try {
    const user = await UserService.getByFid(mockEnv as any, 12345);
    if (user) {
      console.log('✅ User found:', user.fname);
    } else {
      console.log('⚠️  User not found (expected in mock)');
    }
  } catch (error) {
    console.error('❌ Test 2 failed:', error);
  }
  
  console.log('\n');
  
  // Test 3: Auto-creation middleware
  console.log('Test 3: Auto-creation middleware');
  console.log('=================================');
  try {
    const user = await ensureUserExists(mockEnv as any, 67890, 'autouser');
    if (user) {
      console.log('✅ User auto-created:', user);
    } else {
      console.log('❌ Auto-creation failed');
    }
  } catch (error) {
    console.error('❌ Test 3 failed:', error);
  }
  
  console.log('\n');
  
  // Test 4: Upsert existing user
  console.log('Test 4: Upsert existing user');
  console.log('=============================');
  
  // Mock environment with existing user
  const mockEnvWithUser = {
    ...mockEnv,
    DB: {
      prepare: (query: string) => ({
        bind: (...args: any[]) => ({
          first: async () => {
            // Simulate user exists
            if (query.includes('SELECT') && query.includes('WHERE fid = ?')) {
              return {
                id: 1,
                fid: 12345,
                fname: 'oldusername',
                points_balance: 20,
                points_allowance: 20,
                created_at: Date.now(),
                primary_address: null,
                q_cost: 3,
                socials: null,
              };
            }
            
            // Return updated user
            if (query.includes('UPDATE users')) {
              return {
                id: 1,
                fid: 12345,
                fname: 'newusername',
                points_balance: 20,
                points_allowance: 20,
                created_at: Date.now(),
                primary_address: null,
                q_cost: 3,
                socials: null,
              };
            }
            
            return null;
          },
          run: async () => ({ success: true }),
        }),
      }),
    },
  };
  
  try {
    const user = await UserService.upsert(mockEnvWithUser as any, {
      fid: 12345,
      fname: 'newusername',
      displayName: 'Updated User',
    });
    
    console.log('✅ User updated:', user);
    console.log('- New username:', user.fname);
  } catch (error) {
    console.error('❌ Test 4 failed:', error);
  }
  
  console.log('\n');
  console.log('✅ All tests completed!');
  console.log('\nNote: These are mock tests. For real testing, deploy to dev and test with actual auth.');
}

// Run tests
testUserCreation().catch(console.error);

