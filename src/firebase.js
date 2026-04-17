import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAmjyYzL2_c3wTtn3MMsHJW0FuzrkeAg_o",
  authDomain: "finhogar-4d50c.firebaseapp.com",
  projectId: "finhogar-4d50c",
  storageBucket: "finhogar-4d50c.firebasestorage.app",
  messagingSenderId: "591962901651",
  appId: "1:591962901651:web:43fa70563904e6a91b9166"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
