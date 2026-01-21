import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type InsertGift } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";

// ============================================
// API BASE (TEMP SIMPLE FIX FOR PREVIEW)
// ============================================
function apiBase() {
  return "https://thankumail-2.onrender.com";
}
function withBase(url: string) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (!url.startsWith("/")) url = `/${url}`;
  return `${apiBase()}${url}`;
}

// ============================================
// GIFTS HOOKS
// ============================================

export function useGift(publicId: string) {
  return useQuery({
    queryKey: [api.gifts.get.path, publicId],
    queryFn: async () => {
      const url = withBase(buildUrl(api.gifts.get.path, { publicId }));
      const res = await fetch(url, { headers: { accept: "application/json" } });

      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch gift");

      return api.gifts.get.responses[200].parse(await res.json());
    },
    retry: () => false,
  });
}

export function useCreateGift() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertGift) => {
      const validated = api.gifts.create.input.parse(data);

      const url = withBase(api.gifts.create.path);
      const res = await fetch(url, {
        method: api.gifts.create.method,
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify(validated),
      });

      if (!res.ok) {
        if (res.status === 400) {
          const raw = await res.json().catch(() => null);
          try {
            const parsed = api.gifts.create.responses[400].parse(raw);
            throw new Error(parsed.message);
          } catch {
            throw new Error(raw?.error || raw?.message || "Bad request");
          }
        }
        const rawText = await res.text().catch(() => "");
        throw new Error(rawText || "Failed to create gift");
      }

      const json = await res.json();
      try {
        return api.gifts.create.responses[201].parse(json);
      } catch {
        // @ts-ignore
        return api.gifts.create.responses[200]?.parse?.(json) ?? json;
      }
    },
    onError: (error) => {
      toast({
        title: "Error creating gift",
        description: error.message,
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
      const url = withBase(buildUrl(api.gifts.claim.path, { publicId }));
      const res = await fetch(url, {
        method: api.gifts.claim.method,
        headers: { accept: "application/json" },
      });

      if (!res.ok) {
        if (res.status === 400) {
          const raw = await res.json().catch(() => null);
          try {
            const parsed = api.gifts.claim.responses[400].parse(raw);
            throw new Error(parsed.message);
          } catch {
            throw new Error(raw?.error || raw?.message || "Bad request");
          }
        }
        if (res.status === 404) throw new Error("Gift not found");
        const rawText = await res.text().catch(() => "");
        throw new Error(rawText || "Failed to claim gift");
      }

      const json = await res.json();
      try {
        return api.gifts.claim.responses[200].parse(json);
      } catch {
        return json as any;
      }
    },
    onSuccess: (_, publicId) => {
      queryClient.invalidateQueries({ queryKey: [api.gifts.get.path, publicId] });
      toast({
        title: "Woohoo!",
        description: "Gift claimed successfully!",
        className: "bg-green-50 border-green-200 text-green-900",
      });
    },
    onError: (error) => {
      toast({
        title: "Couldn't claim gift",
        description: error.message,
        variant: "destructive",
      });
    },
  });
}
