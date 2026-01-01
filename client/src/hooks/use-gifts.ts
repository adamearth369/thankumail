import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type InsertGift } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";

// ============================================
// GIFTS HOOKS
// ============================================

export function useGift(publicId: string) {
  return useQuery({
    queryKey: [api.gifts.get.path, publicId],
    queryFn: async () => {
      const url = buildUrl(api.gifts.get.path, { publicId });
      const res = await fetch(url);
      
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch gift");
      
      return api.gifts.get.responses[200].parse(await res.json());
    },
    // Don't retry on 404s
    retry: (failureCount, error) => {
      // @ts-ignore - simple check if it was a 404 wrapped in error or null
      return false; 
    }
  });
}

export function useCreateGift() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertGift) => {
      // Validate with Zod before sending if possible, but API handles it too
      const validated = api.gifts.create.input.parse(data);
      
      const res = await fetch(api.gifts.create.path, {
        method: api.gifts.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = api.gifts.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw new Error("Failed to create gift");
      }

      return api.gifts.create.responses[201].parse(await res.json());
    },
    onError: (error) => {
      toast({
        title: "Error creating gift",
        description: error.message,
        variant: "destructive",
      });
    }
  });
}

export function useClaimGift() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (publicId: string) => {
      const url = buildUrl(api.gifts.claim.path, { publicId });
      const res = await fetch(url, {
        method: api.gifts.claim.method,
      });

      if (!res.ok) {
        if (res.status === 400) {
          const error = api.gifts.claim.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        if (res.status === 404) throw new Error("Gift not found");
        throw new Error("Failed to claim gift");
      }

      return api.gifts.claim.responses[200].parse(await res.json());
    },
    onSuccess: (_, publicId) => {
      // Invalidate the specific gift query so UI updates
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
    }
  });
}
