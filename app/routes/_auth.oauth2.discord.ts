import type { HeadersFunction, LoaderArgs } from "@remix-run/node";

import { getUserByDiscordAccount } from "~/models/user.server";
import { exchageDiscordCode, getDiscordAccount } from "~/utils/oauth/discord.server";
import { badRequest, unauthorized } from "~/utils/responses.server";
import { createUserSession } from "~/utils/session.server";

export const headers: HeadersFunction = () => ({
  "X-Robots-Tag": "noindex",
});

export async function loader({ request }: LoaderArgs) {
  const url = new URL(request.url);

  const discordCode = url.searchParams.get("code");
  if (!discordCode) {
    throw badRequest({ message: "Discord OAuth code was not provided" });
  }

  const tokenData = await exchageDiscordCode(discordCode, { type: "login" });
  const discordAccount = await getDiscordAccount(tokenData.access_token);

  const user = await getUserByDiscordAccount(discordAccount.id);
  if (!user) {
    throw unauthorized({
      message: "There's is no user account associated with your Discord account.",
    });
  }

  return createUserSession({
    request,
    userId: user.id,
    remember: true,
    redirectTo: "/me",
  });
}