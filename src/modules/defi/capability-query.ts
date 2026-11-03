import { BadRequestException } from '@nestjs/common';

const MAX_CAPABILITY_IDS = 100;
const MAX_CAPABILITY_ID_LENGTH = 256;
const MAX_QUERY_LENGTH = MAX_CAPABILITY_IDS * (MAX_CAPABILITY_ID_LENGTH + 1);

export function parseCapabilityIds(input: unknown): string[] {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_QUERY_LENGTH) {
    throw new BadRequestException('ids must contain 1-100 capability IDs');
  }
  const ids = input.split(',').map((id) => id.trim());
  if (
    ids.length > MAX_CAPABILITY_IDS ||
    ids.some((id) => !id || id.length > MAX_CAPABILITY_ID_LENGTH) ||
    new Set(ids).size !== ids.length
  ) {
    throw new BadRequestException(
      'ids must contain 1-100 unique, non-empty capability IDs of at most 256 characters',
    );
  }
  return ids;
}
