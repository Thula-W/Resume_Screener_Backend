import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBnxe--ea8dp7_CWnTMwS8MfxaWpkjeR6s",
  authDomain: "resume-screener-29121.firebaseapp.com",
  projectId: "resume-screener-29121",
  storageBucket: "resume-screener-29121.firebasestorage.app",
  messagingSenderId: "460683329301",
  appId: "1:460683329301:web:076cdbf7692c11d8b9331c"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function main() {
  const user = await signInWithEmailAndPassword(
    auth,
    "test@email.com",
    "123456"
  );

  const token = await user.user.getIdToken();
  console.log(token);
}

main();
