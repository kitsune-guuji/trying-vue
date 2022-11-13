import type { ActionArgs, LoaderArgs, MetaFunction } from "@remix-run/node";
import type { TypedErrorResponse } from "~/utils/responses.server";

import { ChevronDoubleLeftIcon } from "@heroicons/react/20/solid";
import { PermissionFlag } from "@prisma/client";
import {
  json,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { Form, Link, useActionData } from "@remix-run/react";

import { Container } from "~/components/Container";
import { Input } from "~/components/Input";
import { Paper } from "~/components/Paper";
import { prisma } from "~/db/prisma.server";
import { useHydrated } from "~/hooks/use-hydrated";
import { nanoid } from "~/lib/nanoid/async.server";
import { sha256HexFromBuffer } from "~/lib/sha256.server";
import { AllowedMimeTypes, FileUpload } from "~/schemas/file.server";
import { arrayBufferToWebp } from "~/utils/image.server";
import { generateMeta } from "~/utils/meta-generator";
import { validateUserPermissions, ValidationMode } from "~/utils/permissions";
import { badRequest } from "~/utils/responses.server";
import { S3_DOMAIN, userUploadToBucket } from "~/utils/s3.server";
import { getAuthorizedUser } from "~/utils/session.server";

export const meta: MetaFunction = () => {
  return generateMeta({
    title: "File Upload",
  });
};

export const loader = async ({ request }: LoaderArgs) => {
  await getAuthorizedUser(request, (user) =>
    validateUserPermissions(user, [PermissionFlag.NEW_ASSET], ValidationMode.STRICT),
  );

  return null;
};

export default function FilesNew() {
  const actionData = useActionData() as ActionData;

  const isHydrated = useHydrated();

  const copyFileUrl = () => {
    if (!isHydrated) {
      return;
    }

    navigator.clipboard.writeText(actionData?.fileUrl ?? "");
  };

  return (
    <Container className="flex max-w-lg flex-col justify-center">
      <Link
        to="/files"
        className="mb-2 flex flex-row items-center text-sm font-semibold uppercase opacity-70"
      >
        <ChevronDoubleLeftIcon className="h-5 w-5" /> Back to browsing files
      </Link>
      {actionData?.fileUrl && (
        <Paper className="mb-4 border-green-800 bg-green-400 text-green-800">
          <p>
            File uploaded,{" "}
            <span onClick={copyFileUrl} className="underline hover:cursor-pointer">
              click to copy url
            </span>
          </p>
        </Paper>
      )}
      {actionData?.error && (
        <Paper className="mb-4 border-red-800 bg-red-400 text-red-800">
          <p>{actionData.error.message}</p>
          <p>{actionData.error.details}</p>
        </Paper>
      )}
      <Paper as={Form} method="post" encType="multipart/form-data" className="flex flex-col">
        <h4 className="text-lg font-semibold">File Upload</h4>
        <p className="mb-6 opacity-60">
          <span>Filename will be randomly generated</span>
          <br />
          <span>File will be converted and compressed to webp</span>
        </p>

        <div className="mb-1">
          <label className="text-xs font-bold uppercase opacity-60">
            File<span className="text-lg text-red-500">*</span>
          </label>
          <input name="file" type="file" className="block overflow-hidden text-ellipsis" required />
        </div>

        <div className="mb-4">
          <label className="text-xs font-bold uppercase opacity-60">
            Tags (tag1, tag2, tag3, ...)
          </label>
          <Input name="tags" fullWidth />
        </div>

        <button className="button" type="submit">
          Upload
        </button>
      </Paper>
    </Container>
  );
}

interface ActionData {
  fileUrl?: string;
  error?: TypedErrorResponse;
}

export const action = async ({ request }: ActionArgs) => {
  const user = await getAuthorizedUser(request, (user) =>
    validateUserPermissions(user, [PermissionFlag.NEW_ASSET], ValidationMode.STRICT),
  );

  const uploadHandler = unstable_createMemoryUploadHandler({
    maxPartSize: 20_000_000,
  });

  const formData = await unstable_parseMultipartFormData(request, uploadHandler);
  const parseForm = await FileUpload.safeParseAsync({
    file: formData.get("file"),
    name: formData.get("filename"),
    tags: formData.get("tags")?.toString().split(",") ?? [],
  });

  if (!parseForm.success) {
    return badRequest<ActionData>({
      error: { message: "Form validation failed", cause: parseForm.error },
    });
  }

  const form = parseForm.data;

  const parseMime = await AllowedMimeTypes.safeParseAsync(form.file.type);
  if (!parseMime.success) {
    return badRequest<ActionData>({
      error: { message: "Unusupported file type provided", cause: parseMime.error },
    });
  }

  const arrayBuffer = await form.file.arrayBuffer();
  const originalBuffer = Buffer.from(arrayBuffer);
  const originalSha256 = await sha256HexFromBuffer(originalBuffer);

  const maybeOriginalFile = await prisma.file.findUnique({ where: { originalSha256 } });
  if (maybeOriginalFile != null) {
    return badRequest<ActionData>({
      error: {
        message: "This file has already been uploaded",
        details: `${S3_DOMAIN}/${maybeOriginalFile.s3Key}`,
      },
    });
  }

  const webpBuffer = await arrayBufferToWebp(arrayBuffer);
  const webpSha256 = await sha256HexFromBuffer(webpBuffer);

  const maybeWebpFile = await prisma.file.findUnique({ where: { sha256: webpSha256 } });
  if (maybeWebpFile != null) {
    return badRequest<ActionData>({
      error: {
        message: "This file has already been uploaded",
        details: `${S3_DOMAIN}/${maybeWebpFile.s3Key}`,
      },
    });
  }

  const fileId = await nanoid(21);
  const filename = fileId + ".webp";
  const [fileUrl] = await userUploadToBucket(webpBuffer, {
    fileId,
    filename,
    originalSha256,
    sha256: webpSha256,
    tags: form.tags,
    userId: user.id,
  });

  return json<ActionData>({ fileUrl });
};