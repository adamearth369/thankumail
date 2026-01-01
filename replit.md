# ThankuMail

## Overview

ThankuMail is an anonymous email gifting service that allows users to send digital gift cards and thank-you notes to recipients. The application enables senders to create gifts with custom messages and amounts, which recipients can then claim through unique, shareable links. The core flow is: create a gift → share the claim link → recipient opens and claims the gift.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state
- **Styling**: Tailwind CSS with shadcn/ui component library (New York style)
- **Animations**: Framer Motion for page transitions and micro-interactions
- **Build Tool**: Vite with custom Replit plugins for development

The frontend follows a simple page-based structure with shared components. Key pages include the Home page (gift creation form) and ClaimGift page (gift claiming experience). The UI emphasizes a playful, friendly aesthetic with custom fonts (DM Sans, Outfit, Patrick Hand) and celebratory effects (canvas-confetti).

### Backend Architecture
- **Framework**: Express.js with TypeScript
- **API Design**: RESTful endpoints with Zod schema validation
- **Database ORM**: Drizzle ORM with PostgreSQL dialect
- **Build**: esbuild for production bundling with selective dependency bundling

The backend exposes three main endpoints:
- `POST /api/gifts` - Create a new gift
- `GET /api/gifts/:publicId` - Retrieve gift details
- `POST /api/gifts/:publicId/claim` - Mark a gift as claimed

Shared route definitions in `shared/routes.ts` provide type-safe API contracts between frontend and backend, with Zod schemas for validation.

### Data Storage
- **Database**: PostgreSQL via Drizzle ORM
- **Schema Location**: `shared/schema.ts`
- **Key Table**: `gifts` table storing recipient email, message, amount (in cents), claim status, and timestamps
- **ID Strategy**: Public-facing IDs are 12-character hex strings (crypto.randomBytes), separate from internal auto-increment IDs

### Project Structure
```
client/          # React frontend
  src/
    components/  # UI components including shadcn/ui
    hooks/       # Custom React hooks
    pages/       # Route pages
    lib/         # Utilities
server/          # Express backend
  routes.ts      # API route handlers
  storage.ts     # Database abstraction layer
  db.ts          # Database connection
shared/          # Shared code between frontend/backend
  schema.ts      # Drizzle schema + Zod types
  routes.ts      # API contract definitions
```

## External Dependencies

### Database
- **PostgreSQL**: Primary database, connection via `DATABASE_URL` environment variable
- **Drizzle Kit**: Schema migrations via `db:push` command

### UI Component Library
- **shadcn/ui**: Pre-built accessible components using Radix UI primitives
- **Radix UI**: Underlying headless UI components (dialogs, popovers, forms, etc.)

### Key NPM Packages
- `@tanstack/react-query`: Server state management
- `drizzle-orm` + `drizzle-zod`: Database ORM with Zod integration
- `framer-motion`: Animations
- `canvas-confetti`: Celebration effects
- `zod`: Runtime type validation
- `date-fns`: Date formatting

### Development Tooling
- Replit-specific Vite plugins for development experience
- TypeScript with path aliases (`@/` for client, `@shared/` for shared code)