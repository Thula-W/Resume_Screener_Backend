import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseServiceRkey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!supabaseUrl || !supabaseServiceRkey) {
  throw new Error('Missing Supabase credentials. Please check your .env file.');
}

// Initialize the Supabase client
export const supabase = createClient(supabaseUrl, supabaseServiceRkey);