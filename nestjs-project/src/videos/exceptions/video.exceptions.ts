import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoUploadTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_TOO_LARGE',
      413,
      'Video exceeds the maximum upload size',
    );
  }
}

export class UnsupportedVideoFormatException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_FORMAT', 415, 'Video format is not supported');
  }
}

export class VideoUploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      409,
      'No upload in progress for this video',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is still being processed');
  }
}

export class VideoProcessingFailedException extends DomainException {
  constructor() {
    super('VIDEO_PROCESSING_FAILED', 409, 'Video processing failed');
  }
}
