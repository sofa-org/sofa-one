import { IsUUID } from 'class-validator';

export class CreateSubscriptionCheckoutDto {
  @IsUUID()
  planVersionId!: string;
}
