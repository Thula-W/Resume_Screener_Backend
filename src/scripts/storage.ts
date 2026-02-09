import { supabase } from "../utils/supabase.ts";

export const testSupabaseStorage = async () => {
  const bucket = "resumes";
  const testPath = "storage-test/test.pdf";
  const testContent = Buffer.from("storage test");

  console.log("🔍 Testing Supabase Storage...");

  // 1️⃣ Upload
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(testPath, testContent, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`❌ Upload failed: ${uploadError.message}`);
  }
  console.log("✅ Upload success");

  // 2️⃣ List
  const { data: listData, error: listError } = await supabase.storage
    .from(bucket)
    .list("storage-test");

  if (listError) {
    throw new Error(`❌ List failed: ${listError.message}`);
  }
  console.log("✅ List success:", listData?.map(f => f.name));

  // 3️⃣ Signed URL
  const { data: signed, error: signError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(testPath, 60);

  if (signError || !signed?.signedUrl) {
    throw new Error(`❌ Signed URL failed: ${signError?.message}`);
  }
  console.log("✅ Signed URL success:", signed.signedUrl);

  // 4️⃣ Delete
  const { error: deleteError } = await supabase.storage
    .from(bucket)
    .remove([testPath]);

  if (deleteError) {
    throw new Error(`❌ Delete failed: ${deleteError.message}`);
  }
  console.log("✅ Delete success");

  console.log("🎉 Supabase Storage is correctly configured");
};
