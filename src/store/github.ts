import { create } from "zustand";
import * as gh from "@/lib/github";

/**
 * The linked GitHub account, read once from the DB and shared by the settings
 * card and the clone dialog, so connecting in one is seen by the other without
 * a reload.
 */
interface GitHubState {
  account: gh.GitHubAccount | null;
  /** False until the first read: `null` before that means "unknown", not "none". */
  loaded: boolean;
  load: () => Promise<void>;
  setAccount: (a: gh.GitHubAccount) => void;
  disconnect: () => Promise<void>;
  /** GitHub refused the saved token: it is forgotten, and the connect row says why. */
  rejected: boolean;
  /** What GitHub answered when it refused, shown as it was said. */
  rejectedDetail: string;
  forgetRejected: (detail?: string) => Promise<void>;
}

export const useGitHub = create<GitHubState>((set) => ({
  account: null,
  loaded: false,
  load: async () => {
    const account = await gh.getAccount();
    set({ account, loaded: true });
  },
  setAccount: (account) => set({ account, loaded: true, rejected: false, rejectedDetail: "" }),
  disconnect: async () => {
    await gh.disconnect();
    set({ account: null, rejected: false, rejectedDetail: "" });
  },
  rejected: false,
  rejectedDetail: "",
  // a token GitHub will never accept again is no account at all; keeping it
  // would leave a "connected" badge over a list that can only fail
  forgetRejected: async (detail = "") => {
    await gh.disconnect();
    set({ account: null, loaded: true, rejected: true, rejectedDetail: detail });
  },
}));
