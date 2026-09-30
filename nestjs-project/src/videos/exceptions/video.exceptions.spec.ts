import { ArgumentsHost } from '@nestjs/common';
import { DomainException } from '../../common/exceptions/domain.exception';
import { DomainExceptionFilter } from '../../common/filters/domain-exception.filter';
import {
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoProcessingFailedException,
  VideoUploadNotInProgressException,
  VideoUploadTooLargeException,
} from './video.exceptions';

/** One row per line of the phase's Error Catalog. */
const CATALOG: [new () => DomainException, string, number, string][] = [
  [VideoNotFoundException, 'VIDEO_NOT_FOUND', 404, 'Video not found'],
  [
    VideoUploadTooLargeException,
    'VIDEO_UPLOAD_TOO_LARGE',
    413,
    'Video exceeds the maximum upload size',
  ],
  [
    UnsupportedVideoFormatException,
    'UNSUPPORTED_VIDEO_FORMAT',
    415,
    'Video format is not supported',
  ],
  [
    VideoUploadNotInProgressException,
    'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    409,
    'No upload in progress for this video',
  ],
  [
    VideoNotReadyException,
    'VIDEO_NOT_READY',
    409,
    'Video is still being processed',
  ],
  [
    VideoProcessingFailedException,
    'VIDEO_PROCESSING_FAILED',
    409,
    'Video processing failed',
  ],
];

describe('video domain exceptions', () => {
  it.each(CATALOG)(
    '%p exposes the errorCode / httpStatus / message of the catalog',
    (Exception, errorCode, httpStatus, message) => {
      const exception = new Exception();

      expect(exception).toBeInstanceOf(DomainException);
      expect(exception.errorCode).toBe(errorCode);
      expect(exception.httpStatus).toBe(httpStatus);
      expect(exception.message).toBe(message);
    },
  );

  it('keeps VIDEO_NOT_READY and VIDEO_PROCESSING_FAILED distinct', () => {
    expect(new VideoNotReadyException().errorCode).not.toBe(
      new VideoProcessingFailedException().errorCode,
    );
  });
});

describe('video domain exceptions through DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    // Only switchToHttp is exercised by DomainExceptionFilter; the remaining
    // ArgumentsHost surface is deliberately absent rather than stubbed.
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/videos/abc', method: 'GET' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it.each(CATALOG)(
    '%p is caught by the global filter and rendered as the catalog envelope',
    (Exception, errorCode, httpStatus, message) => {
      filter.catch(new Exception(), mockHost);

      expect(mockStatus).toHaveBeenCalledWith(httpStatus);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: httpStatus,
        error: errorCode,
        message,
      });
    },
  );

  it('renders VideoNotFoundException as the documented 404 envelope', () => {
    filter.catch(new VideoNotFoundException(), mockHost);

    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });
  });
});
