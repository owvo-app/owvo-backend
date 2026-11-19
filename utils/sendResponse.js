const sendResponse = (res, data) => {
  res.status(data?.statusCode).json({
    success: data.success,
    message: data.message,
    data: data.data,
    ...(data.meta ? { meta: data.meta } : {}),
  });
};

export default sendResponse;