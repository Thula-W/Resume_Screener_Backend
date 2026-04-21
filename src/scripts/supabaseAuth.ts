import { supabaseAuth } from "../config/supabase";

async function main() {
  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: "test@email.com",
    password: "1234",
  });

  if (error) {
    console.error("Login error:", error.message);
    return;
  }

  const session = data.session;

  const token = session?.access_token;

  console.log(token);
}

main();