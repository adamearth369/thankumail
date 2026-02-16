// WHERE TO PASTE: client/src/hooks/use-gifts.ts
// ACTION: Full file replacement (paste exactly)

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type InsertGift } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/apiBase";

// ============================================
// GIFTS HOOKS (simple paths; no schema validators)
// ============================================

type GiftGetOk = any;
type GiftCreateOk = any;
type GiftClaimOk = any;

type ApiError = {
  error?: string;
  message?: string;
  field?: string;
  code?: string;
  codes?: string[];
};

function pickErrorMessage(j: any, fallback: string) {
  const a = j as ApiError;
  return (
    (typeof a?.error === "string" && a.error) ||
    (typeof a?.message === "string" && a.message) ||
    fallback
  );
}

function giftGetPath(publicId: string) {
  return `/api/gifts/${encodeURIComponent(String(publicId || "").trim())}`;
}

function giftClaimPath(publicId: string) {
  return `/api/gifts/${encodeURIComponent(String(publicId || "").trim())}/claim`;
}

export function useGift(publicId: string) {
  return useQuery({
    queryKey: ["gift", publicId],
    queryFn: async () => {
      const url = giftGetPath(publicId);
      const res = await fetch(apiUrl(url));

      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch gift");

      return (await res.json()) as GiftGetOk;
    },
    retry: () => false,
    enabled: !!String(publicId || "").trim(),
  });
}

export function useCreateGift() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertGift) => {
      const res = await fetch(apiUrl(api.createGift), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      let j: any = null;
      try {
        j = await res.json();
      } catch {
        // ignore
      }

      if (!res.ok) {
        throw new Error(pickErrorMessage(j, "Failed to create gift"));
      }

      return (j ?? {}) as GiftCreateOk;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gift"] });
    },
    onError: (error: any) => {
      toast({
        title: "Error creating gift",
        description: String(error?.message || "Request failed"),
        variant: "destructive",
      });
    },
  });
}

export function useClaimGift() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (publicId: string) => {
      const url = giftClaimPath(publicId);
      const res = await fetch(apiUrl(url), { method: "POST" });

      let j: any = null;
      try {
        j = await res.json();
      } catch {
        // ignore
      }

      if (!res.ok) {
        if (res.status === 404) throw new Error("Gift not found");
        throw new Error(pickErrorMessage(j, "Failed to claim gift"));
      }

      return (j ?? {}) as GiftClaimOk;
    },
    onSuccess: (_data, publicId) => {
      queryClient.invalidateQueries({ queryKey: ["gift", publicId] });
      toast({
        title: "Woohoo!",
        description: "Gift claimed successfully!",
        className: "bg-green-50 border-green-200 text-green-900",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Couldn't claim gift",
        description: String(error?.message || "Request failed"),
        variant: "destructive",
      });
    },
  });
}
