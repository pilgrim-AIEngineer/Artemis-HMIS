import { createTrpcHandler } from '@/server/trpc/handler';

export const dynamic = 'force-dynamic';

const handler = createTrpcHandler();

export { handler as GET, handler as POST };
