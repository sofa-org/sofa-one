import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Minimal body for the dashboard-only reconciliation trigger. */
export class ReconcileBodyDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
